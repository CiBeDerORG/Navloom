package transport

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
	"github.com/CiBeDerORG/Navloom/agent/internal/pairing"
	"github.com/CiBeDerORG/Navloom/agent/internal/protocol"
	"github.com/gorilla/websocket"
)

const (
	defaultHeartbeat = 15 * time.Second
	defaultBackoff   = time.Second
	maxBackoff       = 30 * time.Second
	readTimeout      = 50 * time.Second
	maxMessageBytes  = 64 * 1024
)

type options struct {
	heartbeat  time.Duration
	minBackoff time.Duration
	maxBackoff time.Duration
}

func Run(ctx context.Context, cfg config.Config, identity pairing.Identity, version string, log *slog.Logger) error {
	return run(ctx, cfg, identity, version, log, options{
		heartbeat: defaultHeartbeat, minBackoff: defaultBackoff, maxBackoff: maxBackoff,
	})
}

func run(ctx context.Context, cfg config.Config, identity pairing.Identity, version string, log *slog.Logger, opts options) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if identity.AgentID == "" || identity.Credential == "" || version == "" {
		return errors.New("valid paired Agent identity and version required")
	}
	if opts.heartbeat <= 0 || opts.minBackoff <= 0 || opts.maxBackoff < opts.minBackoff {
		return errors.New("invalid transport timing configuration")
	}
	backoff := opts.minBackoff
	for ctx.Err() == nil {
		conn, err := connect(ctx, cfg, identity)
		if err == nil {
			log.Info("Agent WSS connected", "agent_id", identity.AgentID)
			started := time.Now()
			err = serve(ctx, conn, identity.AgentID, version, opts.heartbeat)
			if time.Since(started) >= 2*defaultHeartbeat {
				backoff = opts.minBackoff
			}
		}
		if ctx.Err() != nil {
			return nil
		}
		// Never log credentials or raw Authorization headers.
		log.Warn("Agent WSS unavailable; retrying with backoff", "retry_ms", backoff.Milliseconds())
		jitter := time.Duration(float64(backoff) * (0.8 + 0.4*rand.Float64()))
		timer := time.NewTimer(jitter)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if backoff < opts.maxBackoff {
			backoff *= 2
			if backoff > opts.maxBackoff {
				backoff = opts.maxBackoff
			}
		}
	}
	return nil
}

func connect(ctx context.Context, cfg config.Config, identity pairing.Identity) (*websocket.Conn, error) {
	target, err := url.Parse(cfg.ServerURL)
	if err != nil {
		return nil, errors.New("invalid WSS endpoint")
	}
	if target.Path == "" {
		target.Path = "/agent"
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+identity.Credential)
	headers.Set("X-Navloom-Agent-Id", identity.AgentID)
	headers.Set("X-Navloom-Protocol-Version", strconv.Itoa(protocol.Version))
	dialer := websocket.Dialer{
		HandshakeTimeout:  8 * time.Second,
		Proxy:             http.ProxyFromEnvironment,
		EnableCompression: false,
	}
	conn, response, err := dialer.DialContext(ctx, target.String(), headers)
	if err != nil {
		if response != nil {
			return nil, fmt.Errorf("Agent handshake rejected (HTTP %d)", response.StatusCode)
		}
		return nil, errors.New("Agent connection failed (check Server reachability and TLS)")
	}
	conn.SetReadLimit(maxMessageBytes)
	return conn, nil
}

func serve(ctx context.Context, conn *websocket.Conn, agentID, version string, interval time.Duration) error {
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		return err
	}
	conn.SetPongHandler(func(_ string) error {
		return conn.SetReadDeadline(time.Now().Add(readTimeout))
	})
	hello, err := protocol.NewHello(agentID, version)
	if err != nil {
		return err
	}
	if err := writeMessage(conn, hello); err != nil {
		return err
	}
	started := time.Now()
	heartbeat := func() error {
		msg, err := protocol.NewHeartbeat(agentID, int64(time.Since(started).Seconds()))
		if err != nil {
			return err
		}
		if err := writeMessage(conn, msg); err != nil {
			return err
		}
		return conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
	}
	if err := heartbeat(); err != nil {
		return err
	}
	readDone := make(chan error, 1)
	go func() {
		for {
			kind, _, err := conn.ReadMessage()
			if err != nil {
				readDone <- err
				return
			}
			// Server-to-Agent task commands are deliberately not enabled in this batch.
			if kind == websocket.TextMessage || kind == websocket.BinaryMessage {
				readDone <- errors.New("unexpected Server message type")
				return
			}
		}
	}()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "stopping"), time.Now().Add(time.Second))
			return nil
		case err := <-readDone:
			return err
		case <-ticker.C:
			if err := heartbeat(); err != nil {
				return err
			}
		}
	}
}

func writeMessage(conn *websocket.Conn, msg protocol.Message) error {
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return conn.WriteJSON(msg)
}
