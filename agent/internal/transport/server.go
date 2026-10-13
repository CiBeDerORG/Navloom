package transport

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
	"github.com/CiBeDerORG/Navloom/agent/internal/deploy"
	"github.com/CiBeDerORG/Navloom/agent/internal/pairing"
	"github.com/CiBeDerORG/Navloom/agent/internal/probe"
	"github.com/CiBeDerORG/Navloom/agent/internal/protocol"
	"github.com/gorilla/websocket"
)

// RunPassive never initiates a connection to Server. A trusted Server must
// establish an mTLS WSS connection while at least one logged-in page is open.
func RunPassive(ctx context.Context, cfg config.Config, identity pairing.Identity, version string, log *slog.Logger) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if !cfg.ReverseEndpointConfigured() || identity.AgentID == "" || version == "" {
		return errors.New("passive Agent requires a configured private endpoint and paired identity")
	}
	tlsConfig, err := passiveTLSConfig(cfg, identity)
	if err != nil {
		return err
	}
	journal, err := openOperationJournal(cfg.TokenFile + ".operations.jsonl")
	if err != nil {
		return fmt.Errorf("secure Docker operation journal unavailable: %w", err)
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.EndpointHost, strconv.Itoa(cfg.EndpointPort)))
	if err != nil {
		return fmt.Errorf("listen on private Agent endpoint: %w", err)
	}
	defer listener.Close()
	server := &http.Server{
		Handler:           passiveHandlerWithDeploymentRoot(ctx, identity, version, log, cfg.DeployRoot, journal),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	finished := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = server.Close()
		case <-finished:
		}
	}()
	log.Info("Agent passive WSS listener ready", "host", cfg.EndpointHost, "port", cfg.EndpointPort)
	err = server.Serve(tls.NewListener(listener, tlsConfig))
	close(finished)
	if ctx.Err() != nil || errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func passiveTLSConfig(cfg config.Config, identity pairing.Identity) (*tls.Config, error) {
	if identity.ServerClientCertificatePEM == "" {
		return nil, errors.New("Agent is not paired with a Server client TLS certificate; re-pair required")
	}
	info, err := os.Stat(cfg.TLSKeyFile)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("Agent TLS private key must be a regular private file (0600)")
	}
	own, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
	if err != nil {
		return nil, errors.New("Agent TLS certificate/key invalid")
	}
	ownLeaf, err := x509.ParseCertificate(own.Certificate[0])
	if err != nil || ownLeaf.IsCA || time.Now().Before(ownLeaf.NotBefore) || !time.Now().Before(ownLeaf.NotAfter) ||
		ownLeaf.VerifyHostname(cfg.EndpointHost) != nil ||
		(ownLeaf.KeyUsage != 0 && ownLeaf.KeyUsage&x509.KeyUsageDigitalSignature == 0) || !hasExtKeyUsage(ownLeaf, x509.ExtKeyUsageServerAuth) {
		return nil, errors.New("Agent TLS certificate is invalid for the private WSS endpoint")
	}
	block, rest := pem.Decode([]byte(identity.ServerClientCertificatePEM))
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("invalid pinned Server client TLS certificate")
	}
	pinned, err := x509.ParseCertificate(block.Bytes)
	if err != nil || pinned.IsCA || time.Now().Before(pinned.NotBefore) || !time.Now().Before(pinned.NotAfter) {
		return nil, errors.New("invalid or expired Server client TLS certificate")
	}
	if (pinned.KeyUsage != 0 && pinned.KeyUsage&x509.KeyUsageDigitalSignature == 0) || !hasExtKeyUsage(pinned, x509.ExtKeyUsageClientAuth) {
		return nil, errors.New("pinned Server certificate must be valid for client authentication")
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{own},
		ClientAuth:   tls.RequireAnyClientCert,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) != 1 || !bytes.Equal(state.PeerCertificates[0].Raw, pinned.Raw) {
				return errors.New("untrusted Server client TLS certificate")
			}
			now := time.Now()
			if now.Before(pinned.NotBefore) || !now.Before(pinned.NotAfter) {
				return errors.New("Server client TLS certificate expired")
			}
			return nil
		},
	}, nil
}

func hasExtKeyUsage(cert *x509.Certificate, wanted x509.ExtKeyUsage) bool {
	for _, usage := range cert.ExtKeyUsage {
		if usage == wanted {
			return true
		}
	}
	return false
}

func passiveHandler(ctx context.Context, identity pairing.Identity, version string, log *slog.Logger, journals ...*operationJournal) http.Handler {
	return passiveHandlerWithDeploymentRoot(ctx, identity, version, log, "", journals...)
}

func passiveHandlerWithDeploymentRoot(ctx context.Context, identity pairing.Identity, version string, log *slog.Logger, root string, journals ...*operationJournal) http.Handler {
	var journal *operationJournal
	if len(journals) > 0 {
		journal = journals[0]
	}
	var mu sync.Mutex
	active := false
	upgrader := websocket.Upgrader{
		HandshakeTimeout:  8 * time.Second,
		EnableCompression: false,
		CheckOrigin: func(r *http.Request) bool {
			return r.Header.Get("Origin") == "" // Server-to-Agent only, never a browser WebSocket.
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 || identity.ServerClientCertificatePEM == "" {
			http.Error(w, "mTLS client identity required", http.StatusUnauthorized)
			return
		}
		block, _ := pem.Decode([]byte(identity.ServerClientCertificatePEM))
		if block == nil || !bytes.Equal(r.TLS.PeerCertificates[0].Raw, block.Bytes) {
			http.Error(w, "untrusted client", http.StatusUnauthorized)
			return
		}
		if r.Header.Get("X-Navloom-Agent-Id") != identity.AgentID ||
			r.Header.Get("X-Navloom-Protocol-Version") != strconv.Itoa(protocol.Version) {
			http.Error(w, "Agent identity/protocol mismatch", http.StatusUnauthorized)
			return
		}
		mu.Lock()
		if active {
			mu.Unlock()
			http.Error(w, "Agent already connected", http.StatusConflict)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			mu.Unlock()
			return
		}
		active = true
		mu.Unlock()
		defer func() {
			conn.Close()
			mu.Lock()
			active = false
			mu.Unlock()
		}()
		conn.SetReadLimit(maxMessageBytes)
		cancelClose := context.AfterFunc(ctx, func() {
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseGoingAway, "Agent stopping"), time.Now().Add(time.Second))
			_ = conn.Close()
		})
		defer cancelClose()
		var sendMu sync.Mutex
		send := func(message protocol.Message) error {
			sendMu.Lock()
			defer sendMu.Unlock()
			return writeMessage(conn, message)
		}
		hello, err := protocol.NewHello(identity.AgentID, version)
		if err != nil || send(hello) != nil {
			return
		}
		watchCtx, stopWatching := context.WithCancel(ctx)
		defer stopWatching()
		go func() {
			for watchCtx.Err() == nil {
				_ = probe.WatchDockerEvents(watchCtx, func(change probe.ContainerEvent) {
					event, err := protocol.NewInventoryChanged(identity.AgentID, change.ContainerID, change.Action)
					if err != nil || send(event) != nil {
						stopWatching()
					}
				})
				if watchCtx.Err() != nil {
					return
				}
				select {
				case <-watchCtx.Done():
					return
				case <-time.After(30 * time.Second):
				}
			}
		}()
		log.Info("Server connected to passive Agent", "agent_id", identity.AgentID)
		// Prevent replay inside one authenticated WSS session, including when a
		// fresh message_id is paired with a task_id that already ran. The ledger
		// is bounded; future mutating operations also require durable dedupe.
		seenTasks := make(map[string]struct{})
		seenMessages := make(map[string]struct{})
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if kind != websocket.TextMessage {
				_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseUnsupportedData, "text required"), time.Now().Add(time.Second))
				return
			}
			task, err := protocol.DecodeTaskDispatch(data, identity.AgentID)
			if err != nil {
				_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "task rejected"), time.Now().Add(time.Second))
				return
			}
			if _, replay := seenTasks[task.TaskID]; replay {
				_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "replayed task"), time.Now().Add(time.Second))
				return
			}
			if _, replay := seenMessages[task.MessageID]; replay {
				_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "replayed message"), time.Now().Add(time.Second))
				return
			}
			if len(seenTasks) >= maxTasksPerSession {
				_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session task limit"), time.Now().Add(time.Second))
				return
			}
			seenTasks[task.TaskID] = struct{}{}
			seenMessages[task.MessageID] = struct{}{}
			switch protocol.TaskOperation(task) {
			case "compose_status":
				if root == "" {
					result, err := protocol.NewTaskFailure(identity.AgentID, task.TaskID, "deployment receipt directory not configured")
					if err != nil || send(result) != nil {
						return
					}
					continue
				}
				installTaskID := protocol.TaskInstallID(task)
				receipt, err := (deploy.Executor{Root: root}).Reconcile(installTaskID)
				if err != nil {
					result, failed := protocol.NewTaskFailure(identity.AgentID, task.TaskID, "deployment receipt unavailable")
					if failed != nil || send(result) != nil {
						return
					}
					continue
				}
				result, err := protocol.NewComposeStatusResult(identity.AgentID, task.TaskID,
					receipt.TaskID, receipt.Status, receipt.Project, receipt.ExitCode)
				if err != nil || send(result) != nil {
					return
				}
			case "capability_probe":
				capabilities := probe.DiscoverDocker(ctx)
				result, err := protocol.NewCapabilityResult(identity.AgentID, task.TaskID, capabilities)
				if err != nil || send(result) != nil {
					return
				}
			case "container_start", "container_stop", "container_restart":
				if journal == nil {
					result, err := protocol.NewTaskFailure(identity.AgentID, task.TaskID, "persistent journal unavailable")
					if err != nil || send(result) != nil {
						return
					}
					continue
				}
				containerID := protocol.TaskContainerID(task)
				claimed, err := journal.claim(journalEntry{
					TaskID: task.TaskID, Operation: protocol.TaskOperation(task), ContainerID: containerID,
				})
				if err != nil || !claimed {
					result, failed := protocol.NewTaskFailure(identity.AgentID, task.TaskID, "operation already claimed or journal unavailable")
					if failed != nil || send(result) != nil {
						return
					}
					continue
				}
				if err := probe.ControlContainer(ctx, protocol.TaskOperation(task), containerID); err != nil {
					result, failed := protocol.NewTaskFailure(identity.AgentID, task.TaskID, "Docker operation failed")
					if failed != nil || send(result) != nil {
						return
					}
					continue
				}
				result, err := protocol.NewOperationResult(identity.AgentID, task.TaskID, true)
				if err != nil || send(result) != nil {
					return
				}
			case "container_logs":
				lines, err := probe.ReadContainerLogs(ctx, protocol.TaskContainerID(task))
				if err != nil {
					result, failed := protocol.NewTaskFailure(identity.AgentID, task.TaskID, "Docker logs unavailable")
					if failed != nil || send(result) != nil {
						return
					}
					continue
				}
				for idx, line := range lines {
					entry, err := protocol.NewTaskLog(identity.AgentID, task.TaskID, idx, line)
					if err != nil || send(entry) != nil {
						return
					}
				}
				result, err := protocol.NewOperationResult(identity.AgentID, task.TaskID, true)
				if err != nil || send(result) != nil {
					return
				}
			case "inventory_refresh":
				items, err := probe.ListContainers(ctx)
				if err != nil {
					result, failure := protocol.NewTaskFailure(identity.AgentID, task.TaskID, "Docker inventory unavailable")
					if failure != nil || send(result) != nil {
						return
					}
					continue
				}
				chunks := 0
				for offset := 0; offset < len(items); offset += 20 {
					end := offset + 20
					if end > len(items) {
						end = len(items)
					}
					chunk, err := protocol.NewInventoryChunk(identity.AgentID, task.TaskID, chunks, items[offset:end])
					if err != nil || send(chunk) != nil {
						return
					}
					chunks++
				}
				result, err := protocol.NewInventoryResult(identity.AgentID, task.TaskID, len(items), chunks)
				if err != nil || send(result) != nil {
					return
				}
			default:
				return
			}
		}
	})
}

// The passive Agent only writes a hello or an explicit task result.
const maxMessageBytes = 64 * 1024
const maxTasksPerSession = 1024

func writeMessage(conn *websocket.Conn, message protocol.Message) error {
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return conn.WriteJSON(message)
}
