package probe

import (
	"context"
	"encoding/binary"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func mockDockerSocket(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close(); _ = listener.Close() })
	return socket
}

func TestDockerControlsUseFixedPostRoutesAndRejectUnknownCommands(t *testing.T) {
	calls := 0
	socket := mockDockerSocket(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Path, "/containers/") {
			t.Errorf("unexpected Docker method/path: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	id := strings.Repeat("a", 64)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, operation := range []string{"container_start", "container_stop", "container_restart"} {
		if err := controlContainerAt(ctx, socket, operation, id); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 3 {
		t.Fatalf("expected three explicit Docker POST requests, got %d", calls)
	}
	if err := controlContainerAt(ctx, socket, "shell", id); err == nil {
		t.Fatal("arbitrary Docker or shell operation accepted")
	}
	if err := controlContainerAt(ctx, socket, "container_start", "../evil"); err == nil {
		t.Fatal("container path traversal accepted")
	}
	if calls != 3 {
		t.Fatalf("invalid operation reached Docker socket: %d", calls)
	}
}

func TestDockerLogsBoundedReadOnlyStream(t *testing.T) {
	content := []byte("2026-10-12 hello from container\n")
	stream := make([]byte, 8+len(content))
	stream[0] = 1
	binary.BigEndian.PutUint32(stream[4:8], uint32(len(content)))
	copy(stream[8:], content)
	socket := mockDockerSocket(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/logs") ||
			r.URL.Query().Get("tail") != "100" || r.URL.Query().Get("stdout") != "1" {
			t.Errorf("unsafe Docker logs endpoint: %s %s", r.Method, r.URL.String())
		}
		_, _ = w.Write(stream)
	})
	lines, err := readContainerLogsAt(context.Background(), socket, strings.Repeat("b", 64))
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0] != "2026-10-12 hello from container" {
		t.Fatalf("Docker multiplexed logs not decoded: %+v", lines)
	}
	if _, err := readContainerLogsAt(context.Background(), socket, "not-a-container"); err == nil {
		t.Fatal("invalid container ID accepted for logs")
	}
}

func TestDockerControlsRefusePlainFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-socket")
	if err := os.WriteFile(path, []byte("not Docker"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := controlContainerAt(context.Background(), path, "container_start", strings.Repeat("c", 64)); err == nil {
		t.Fatal("unsafe Unix socket path accepted")
	}
}

func TestDockerLogsRedactCommonCredentialPatterns(t *testing.T) {
	input := "password=correcthorsebatterystaple api_key:secret123 Authorization: Bearer abc.def token=opaque"
	output := sanitizeLogLine(input)
	for _, secret := range []string{"correcthorsebatterystaple", "secret123", "abc.def", "opaque"} {
		if strings.Contains(output, secret) {
			t.Fatalf("common credential pattern leaked into admin logs: %s", secret)
		}
	}
	if !strings.Contains(output, "[REDACTED]") {
		t.Fatal("expected visible redaction marker")
	}
}
