package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
	"github.com/CiBeDerORG/Navloom/agent/internal/pairing"
	"github.com/CiBeDerORG/Navloom/agent/internal/protocol"
	"github.com/gorilla/websocket"
)

const testAgentID = "4b0182c1-9312-4a42-a816-24fdfda39b55"
const testCredential = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func clientTLSCert(t *testing.T) (tls.Certificate, string) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "Navloom Server test"},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	publicPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	pair, err := tls.X509KeyPair([]byte(publicPEM), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}))
	if err != nil {
		t.Fatal(err)
	}
	return pair, publicPEM
}

func TestPassiveAgentMutualTLSAndOnlyOnDemandTraffic(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{
		ServerURL:    "wss://navloom.example.com/agent",
		AgentName:    "nas",
		EndpointHost: "10.10.20.30",
		EndpointPort: 9443,
		TLSCertFile:  filepath.Join(dir, "agent.crt"),
		TLSKeyFile:   filepath.Join(dir, "agent.key"),
	}
	if err := pairing.GenerateAgentTLS(cfg); err != nil {
		t.Fatal(err)
	}
	client, publicPEM := clientTLSCert(t)
	identity := pairing.Identity{AgentID: testAgentID, Credential: testCredential, ServerClientCertificatePEM: publicPEM}
	tlsConfig, err := passiveTLSConfig(cfg, identity)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := httptest.NewUnstartedServer(passiveHandler(ctx, identity, "m2-passive", slog.New(slog.NewTextHandler(io.Discard, nil))))
	server.TLS = tlsConfig
	server.StartTLS()
	defer server.Close()
	certPEM, err := os.ReadFile(cfg.TLSCertFile)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certPEM) {
		t.Fatal("cannot trust Agent certificate")
	}
	makeDialer := func(certificates []tls.Certificate) *websocket.Dialer {
		return &websocket.Dialer{TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: cfg.EndpointHost, Certificates: certificates,
		}}
	}
	url := strings.Replace(server.URL, "https://", "wss://", 1) + "/agent"
	headers := http.Header{}
	headers.Set("X-Navloom-Agent-Id", testAgentID)
	headers.Set("X-Navloom-Protocol-Version", "2")
	if conn, _, err := makeDialer(nil).Dial(url, headers); err == nil {
		conn.Close()
		t.Fatal("missing Server client certificate was accepted")
	}
	other, _ := clientTLSCert(t)
	if conn, _, err := makeDialer([]tls.Certificate{other}).Dial(url, headers); err == nil {
		conn.Close()
		t.Fatal("untrusted Server client certificate was accepted")
	}
	wrongID := http.Header{}
	wrongID.Set("X-Navloom-Agent-Id", "00000000-0000-4000-8000-000000000000")
	wrongID.Set("X-Navloom-Protocol-Version", "2")
	if conn, response, err := makeDialer([]tls.Certificate{client}).Dial(url, wrongID); err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
		if conn != nil {
			conn.Close()
		}
		t.Fatalf("mismatched Agent ID not rejected: %v", err)
	}
	conn, _, err := makeDialer([]tls.Certificate{client}).Dial(url, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var hello struct {
		Type    string `json:"type"`
		AgentID string `json:"agent_id"`
	}
	if err := conn.ReadJSON(&hello); err != nil || hello.Type != "hello" || hello.AgentID != testAgentID {
		t.Fatalf("invalid hello: %+v, %v", hello, err)
	}
	if second, response, err := makeDialer([]tls.Certificate{client}).Dial(url, headers); err == nil || response == nil || response.StatusCode != http.StatusConflict {
		if second != nil {
			second.Close()
		}
		t.Fatalf("duplicate Server WSS accepted: %v", err)
	}
	taskID := "de57a2f3-38da-4cb7-a676-81b3950b9701"
	task, err := json.Marshal(map[string]any{
		"protocol_version": protocol.Version,
		"message_id":       "a57be91b-cbf5-4c84-93cb-b07c126bb18a",
		"agent_id":         testAgentID,
		"task_id":          taskID,
		"sent_at":          time.Now().UTC().Format(time.RFC3339),
		"type":             "task_dispatch",
		"payload":          map[string]any{"operation": "capability_probe", "arguments": map[string]any{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, task); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Type   string `json:"type"`
		TaskID string `json:"task_id"`
	}
	if err := conn.ReadJSON(&result); err != nil || result.Type != "task_result" || result.TaskID != taskID {
		t.Fatalf("invalid task result: %+v, %v", result, err)
	}
	pong := make(chan struct{}, 1)
	conn.SetPongHandler(func(string) error {
		select {
		case pong <- struct{}{}:
		default:
		}
		return nil
	})
	if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, err = conn.ReadMessage() // only Pong is expected; no JSON heartbeat or autonomous traffic
	if err == nil {
		t.Fatal("Agent sent unsolicited application traffic")
	}
	select {
	case <-pong:
	default:
		t.Fatal("Agent did not answer Server Ping with Pong")
	}
}
