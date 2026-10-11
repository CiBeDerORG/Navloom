package probe

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/protocol"
)

func reason(value string) *string { return &value }

// DiscoverDocker is read-only: GET /_ping and /version on a local Unix socket,
// plus a fixed-argument "docker compose version --short" subprocess. It never
// accepts task-supplied paths, commands, or shell input.
func DiscoverDocker(ctx context.Context) protocol.Capabilities {
	result := protocol.Capabilities{
		Platform: runtime.GOOS, Architecture: runtime.GOARCH,
		Docker: protocol.DockerCapability{Reason: reason("daemon_unreachable")},
		Compose: protocol.ComposeCapability{Reason: reason("compose_unavailable")},
	}
	result.Docker = detectEngine(ctx)
	result.Compose = detectCompose(ctx)
	return result
}

func detectEngine(ctx context.Context) protocol.DockerCapability {
	host := os.Getenv("DOCKER_HOST")
	socket := "/var/run/docker.sock"
	if host != "" {
		switch host {
		case "unix:///var/run/docker.sock", "unix:///run/docker.sock":
			socket = strings.TrimPrefix(host, "unix://")
		default:
			return protocol.DockerCapability{Reason: reason("unsupported_host")}
		}
	}
	return detectEngineAt(ctx, socket)
}

func detectEngineAt(ctx context.Context, socket string) protocol.DockerCapability {
	info, err := os.Stat(socket)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return protocol.DockerCapability{Reason: reason("socket_missing")}
		}
		if errors.Is(err, os.ErrPermission) {
			return protocol.DockerCapability{Reason: reason("permission_denied")}
		}
		return protocol.DockerCapability{Reason: reason("daemon_unreachable")}
	}
	if info.Mode()&os.ModeSocket == 0 {
		return protocol.DockerCapability{Reason: reason("daemon_unreachable")}
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 2*time.Second}).DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	for _, path := range []string{"/_ping", "/version"} {
		req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, "http://docker"+path, nil)
		if err != nil {
			return protocol.DockerCapability{Reason: reason("daemon_unreachable")}
		}
		response, err := client.Do(req)
		if err != nil {
			if errors.Is(err, os.ErrPermission) || strings.Contains(err.Error(), "permission denied") {
				return protocol.DockerCapability{Reason: reason("permission_denied")}
			}
			return protocol.DockerCapability{Reason: reason("daemon_unreachable")}
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
		_ = response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK {
			return protocol.DockerCapability{Reason: reason("daemon_unreachable")}
		}
		if path == "/version" {
			var version struct { APIVersion string `json:"ApiVersion"` }
			if json.Unmarshal(body, &version) != nil || len(version.APIVersion) == 0 || len(version.APIVersion) > 40 {
				return protocol.DockerCapability{Reason: reason("version_unavailable")}
			}
			return protocol.DockerCapability{Available: true, APIVersion: &version.APIVersion}
		}
	}
	return protocol.DockerCapability{Reason: reason("version_unavailable")}
}

func detectCompose(ctx context.Context) protocol.ComposeCapability {
	path, err := exec.LookPath("docker")
	if err != nil {
		return protocol.ComposeCapability{Reason: reason("cli_missing")}
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	// Fixed executable and arguments, no shell. Do not log stdout/stderr.
	output, err := exec.CommandContext(probeCtx, path, "compose", "version", "--short").Output()
	if err != nil {
		if errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
			return protocol.ComposeCapability{Reason: reason("timeout")}
		}
		return protocol.ComposeCapability{Reason: reason("compose_unavailable")}
	}
	version := strings.TrimSpace(string(output))
	if version == "" || len(version) > 80 || strings.ContainsAny(version, "\r\n") {
		return protocol.ComposeCapability{Reason: reason("compose_unavailable")}
	}
	return protocol.ComposeCapability{Available: true, Version: &version}
}
