package pairing

import (
	"context"
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

func TestLegacyPairRejectedAndPrivateIdentity(t *testing.T) {
	cfg := config.Config{ServerURL: "ws://127.0.0.1:9/agent", AgentName: "my-nas", AllowInsecureDev: true}
	if _, err := Pair(context.Background(), cfg, sampleSecret, "0.1.0-m2"); err == nil {
		t.Fatal("pairing without private endpoint and TLS must be rejected before network access")
	}
	identity := Identity{AgentID: sampleID, Credential: sampleSecret}
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
	dir := t.TempDir()
	cfg := config.Config{
		ServerURL: strings.Replace(server.URL, "http://", "ws://", 1) + "/agent",
		AgentName: "nas", AllowInsecureDev: true,
		EndpointHost: "10.10.20.30", EndpointPort: 9443,
		TLSCertFile: filepath.Join(dir, "agent.crt"),
		TLSKeyFile:  filepath.Join(dir, "agent.key"),
	}
	if err := GenerateAgentTLS(cfg); err != nil {
		t.Fatal(err)
	}
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
