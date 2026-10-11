package probe

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestDockerUnixAPIProbeAndFailure(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Unix Docker socket probe runs on Linux")
	}
	path := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/_ping":
			_, _ = w.Write([]byte("OK"))
		case "/version":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ApiVersion":"1.47"}`))
		default:
			t.Errorf("unexpected Docker API request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	server.Listener.Close()
	server.Listener = listener
	server.Start()
	defer server.Close()
	got := detectEngineAt(context.Background(), path)
	if !got.Available || got.APIVersion == nil || *got.APIVersion != "1.47" || got.Reason != nil {
		t.Fatalf("Docker API probe failed: %+v", got)
	}
	missing := detectEngineAt(context.Background(), filepath.Join(t.TempDir(), "missing.sock"))
	if missing.Available || missing.Reason == nil || *missing.Reason != "socket_missing" {
		t.Fatalf("missing socket not reported: %+v", missing)
	}
}

func TestComposeFixedArgumentsAndUnsupportedRemoteDockerHost(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux shell stub")
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "docker")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nif [ \"$1\" = compose ] && [ \"$2\" = version ] && [ \"$3\" = --short ]; then printf 'v2.39.0\\n'; else exit 2; fi\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	got := detectCompose(ctx)
	if !got.Available || got.Version == nil || *got.Version != "v2.39.0" {
		t.Fatalf("Compose detection failed: %+v", got)
	}
	t.Setenv("DOCKER_HOST", "tcp://evil.example:2375")
	docker := detectEngine(ctx)
	if docker.Available || docker.Reason == nil || *docker.Reason != "unsupported_host" {
		t.Fatalf("remote Docker host must not be probed: %+v", docker)
	}
}
