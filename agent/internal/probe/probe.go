package probe

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/url"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
)

// Check tests TCP/TLS reachability only; it does not perform a WebSocket handshake.
func Check(ctx context.Context, cfg config.Config) error {
	target, err := url.Parse(cfg.ServerURL)
	if err != nil {
		return fmt.Errorf("parse Server URL: %w", err)
	}
	port := target.Port()
	if port == "" {
		if target.Scheme == "wss" {
			port = "443"
		} else {
			port = "80"
		}
	}
	address := net.JoinHostPort(target.Hostname(), port)
	dialer := &net.Dialer{Timeout: 5 * time.Second}

	var conn net.Conn
	if target.Scheme == "wss" {
		tlsDialer := &tls.Dialer{
			NetDialer: dialer,
			Config:    &tls.Config{MinVersion: tls.VersionTLS12, ServerName: target.Hostname()},
		}
		conn, err = tlsDialer.DialContext(ctx, "tcp", address)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return fmt.Errorf("cannot reach Navloom Server at %s: %w", target.Host, err)
	}
	return conn.Close()
}
