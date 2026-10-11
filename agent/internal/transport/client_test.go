package transport

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
	"github.com/CiBeDerORG/Navloom/agent/internal/pairing"
	"github.com/CiBeDerORG/Navloom/agent/internal/protocol"
	"github.com/gorilla/websocket"
)

const testAgentID = "4b0182c1-9312-4a42-a816-24fdfda39b55"
const testCredential = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func identity() pairing.Identity {
	return pairing.Identity{AgentID: testAgentID, Credential: testCredential}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func testConfig(serverURL string) config.Config {
	return config.Config{
		ServerURL: strings.Replace(serverURL, "http://", "ws://", 1) + "/agent",
		AgentName: "test-nas", AllowInsecureDev: true,
	}
}

func TestConnectHeartbeatAndReconnect(t *testing.T) {
	var connections atomic.Int32
	var heartbeats atomic.Int32
	var invalid atomic.Bool
	upgrader := websocket.Upgrader{CheckOrigin: func(_ *http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent" || r.Header.Get("Authorization") != "Bearer "+testCredential ||
			r.Header.Get("X-Navloom-Agent-Id") != testAgentID || r.Header.Get("X-Navloom-Protocol-Version") != "1" {
			invalid.Store(true)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			invalid.Store(true)
			return
		}
		defer conn.Close()
		connections.Add(1)
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			msg, payload, err := protocol.DecodeHeartbeat(data)
			if err == nil && msg.AgentID == testAgentID && payload.UptimeSeconds >= 0 {
				heartbeats.Add(1)
				if connections.Load() == 1 {
					_ = conn.Close()
					return
				}
			} else if !strings.Contains(string(data), "\"type\":\"hello\"") {
				invalid.Store(true)
				return
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, testConfig(server.URL), identity(), "0.1.0-test", testLogger(), options{
			heartbeat: 30 * time.Millisecond, minBackoff: 25 * time.Millisecond, maxBackoff: 100 * time.Millisecond,
		})
	}()
	deadline := time.After(2 * time.Second)
	for connections.Load() < 2 || heartbeats.Load() < 2 {
		select {
		case <-deadline:
			t.Fatalf("reconnect/heartbeat timed out: connections=%d heartbeats=%d", connections.Load(), heartbeats.Load())
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if invalid.Load() {
		t.Fatal("invalid handshake or heartbeat")
	}
}

func TestRejectsInvalidTLSAndNoFastRetry(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("TLS should be rejected before HTTP request")
	}))
	defer server.Close()
	cfg := config.Config{ServerURL: strings.Replace(server.URL, "https://", "wss://", 1) + "/agent", AgentName: "test-nas"}
	_, err := connect(context.Background(), cfg, identity())
	if err == nil {
		t.Fatal("self-signed TLS must be rejected")
	}
	var attempts atomic.Int32
	badServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer badServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Millisecond)
	defer cancel()
	if err := run(ctx, testConfig(badServer.URL), identity(), "test", testLogger(), options{
		heartbeat: 20 * time.Millisecond, minBackoff: 50 * time.Millisecond, maxBackoff: 150 * time.Millisecond,
	}); err != nil {
		t.Fatal(err)
	}
	if attempts.Load() > 5 {
		t.Fatalf("too many rapid retries: %d", attempts.Load())
	}
}

func TestCancellationClosesConnection(t *testing.T) {
	closed := make(chan struct{}, 1)
	upgrader := websocket.Upgrader{CheckOrigin: func(_ *http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				closed <- struct{}{}
				return
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, testConfig(server.URL), identity(), "test", testLogger(), options{
			heartbeat: 20 * time.Millisecond, minBackoff: 20 * time.Millisecond, maxBackoff: 100 * time.Millisecond,
		})
	}()
	time.Sleep(70 * time.Millisecond)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("socket was not closed")
	}
}
