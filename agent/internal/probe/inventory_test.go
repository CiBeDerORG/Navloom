package probe

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDockerInventoryDiscoversStoppedContainersAndOnlyComposeLabels(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	calls := 0
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			if r.Method != http.MethodGet || r.URL.Path != "/containers/json" || r.URL.Query().Get("all") != "1" {
				http.Error(w, "unexpected Docker request", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{
					"Id": strings.Repeat("a", 64), "Names": []string{"/existing-running"},
					"Image": "nginx:stable", "State": "running",
					"Ports": []map[string]any{{"PrivatePort": 80, "PublicPort": 8080, "Type": "tcp", "IP": "0.0.0.0"}},
					"Labels": map[string]string{
						"com.docker.compose.project": "site",
						"com.docker.compose.service": "web",
						"secret.access.token":        "never-persist-this",
					},
				},
				{
					"Id": strings.Repeat("b", 64), "Names": []string{"/old-stopped"},
					"Image": "alpine:3", "State": "exited",
				},
			})
		}),
	}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	got, err := listContainersAt(ctx, socket)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || len(got) != 2 {
		t.Fatalf("expected exactly one all=true Docker read with two containers, got calls=%d items=%d", calls, len(got))
	}
	if got[1].Name != "old-stopped" || got[1].State != "exited" {
		t.Fatalf("stopped container missing: %+v", got[1])
	}
	if got[0].ComposeProject == nil || *got[0].ComposeProject != "site" || len(got[0].Labels) != 2 {
		t.Fatalf("Compose labels not normalized: %+v", got[0])
	}
	if strings.Contains(strings.Join(mapValues(got[0].Labels), ","), "never-persist-this") {
		t.Fatal("untrusted Docker secret label leaked to snapshot")
	}
	if len(got[0].Ports) != 1 || got[0].Ports[0].PublicPort == nil || *got[0].Ports[0].PublicPort != 8080 {
		t.Fatalf("Docker published port missing: %+v", got[0].Ports)
	}
	if _, err := os.Stat(socket); err != nil {
		t.Fatal(err)
	}
}

func mapValues(m map[string]string) []string {
	items := make([]string, 0, len(m))
	for _, value := range m {
		items = append(items, value)
	}
	return items
}

func TestDockerInventoryRefusesNonSocketOrUnsupportedHost(t *testing.T) {
	target := filepath.Join(t.TempDir(), "not-a-socket")
	if err := os.WriteFile(target, []byte("not Docker"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := listContainersAt(context.Background(), target); err == nil {
		t.Fatal("plain file was accepted as Docker Unix socket")
	}
	t.Setenv("DOCKER_HOST", "tcp://127.0.0.1:2375")
	if _, err := inventorySocket(); err == nil {
		t.Fatal("untrusted Docker TCP endpoint was accepted")
	}
}
