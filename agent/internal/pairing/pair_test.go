package pairing

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
)

const sampleID = "4b0182c1-9312-4a42-a816-24fdfda39b55"
const sampleSecret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func TestPairAndPrivateIdentity(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/api/v1/agent/pair" || r.Method != http.MethodPost || r.Header.Get("X-Navloom-CSRF") != "1" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["token"] != sampleSecret || body["name"] != "my-nas" || body["platform"] == "" {
			t.Errorf("invalid pairing payload")
		}
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"agentId":"4b0182c1-9312-4a42-a816-24fdfda39b55","credential":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`))
	}))
	defer server.Close()
	cfg := config.Config{ServerURL: strings.Replace(server.URL, "http://", "ws://", 1) + "/agent", AgentName: "my-nas", AllowInsecureDev: true}
	identity, err := Pair(context.Background(), cfg, sampleSecret, "0.1.0-m2")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || identity.AgentID != sampleID || identity.Credential != sampleSecret {
		t.Fatalf("pairing mismatch")
	}
	path := filepath.Join(t.TempDir(), "identity", "agent.json")
	if err := SaveIdentity(path, identity); err != nil {
		t.Fatal(err)
	}
	stat, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if stat.Mode().Perm() != 0600 {
		t.Fatalf("identity file mode: %v", stat.Mode().Perm())
	}
	loaded, err := LoadIdentity(path)
	if err != nil || loaded != identity {
		t.Fatalf("identity load failed: %v", err)
	}
	if err := SaveIdentity(path, identity); err == nil {
		t.Fatal("identity overwrite must be rejected")
	}
}

func TestPairRejectsRedirectsAndUnsafeURLs(t *testing.T) {
	otherCalled := false
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { otherCalled = true }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	cfg := config.Config{ServerURL: strings.Replace(server.URL, "http://", "ws://", 1) + "/agent", AgentName: "nas", AllowInsecureDev: true}
	if _, err := Pair(context.Background(), cfg, sampleSecret, "test"); err == nil {
		t.Fatal("redirect must be rejected")
	}
	if otherCalled {
		t.Fatal("redirect target received secret")
	}
	cfg.ServerURL = "ws://example.com/agent"
	if _, err := Pair(context.Background(), cfg, sampleSecret, "test"); err == nil {
		t.Fatal("insecure remote connection must be rejected")
	}
}

func TestReadTokenAndIdentityPermissions(t *testing.T) {
	got, err := ReadToken(strings.NewReader(sampleSecret + "\n"))
	if err != nil || got != sampleSecret {
		t.Fatalf("unexpected token: %v", err)
	}
	if _, err := ReadToken(strings.NewReader("not-a-token\n")); err == nil {
		t.Fatal("malformed token must fail")
	}
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte(`{"agent_id":"4b0182c1-9312-4a42-a816-24fdfda39b55","credential":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadIdentity(path); err == nil {
		t.Fatal("public-readable identity must be rejected")
	}
}


func TestPairRequiresValidReverseEndpointConfiguration(t *testing.T) {
	cfg := config.Config{
		ServerURL: "wss://navloom.example.com/agent", AgentName: "nas",
		EndpointHost: "8.8.8.8", EndpointPort: 9443,
		TLSCertFile: "/tmp/agent.crt", TLSKeyFile: "/tmp/agent.key",
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("public Agent endpoint must be rejected")
	}
	cfg.EndpointHost = "10.20.30.40"
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	if _, err := Pair(context.Background(), cfg, sampleSecret, "test"); err == nil {
		t.Fatal("pairing must reject missing Agent TLS certificate")
	}
}
