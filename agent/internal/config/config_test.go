package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRequiresSecureServerURL(t *testing.T) {
	cases := []struct {
		url   string
		allow bool
		valid bool
	}{
		{"wss://example.com/agent", false, true},
		{"ws://example.com/agent", true, false},
		{"ws://127.0.0.1:3000/agent", false, false},
		{"ws://127.0.0.1:3000/agent", true, true},
		{"ws://localhost:3000/agent", true, true},
		{"https://example.com/agent", false, false},
		{"wss://user:secret@example.com/agent", false, false},
		{"wss://example.com/agent?token=secret", false, false},
		{"", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.url, func(t *testing.T) {
			cfg := Config{ServerURL: tc.url, AgentName: "nas", AllowInsecureDev: tc.allow}
			if got := cfg.Validate() == nil; got != tc.valid {
				t.Fatalf("Validate() success = %t, want %t", got, tc.valid)
			}
		})
	}
}

func TestLoadJSONAndEnvironmentOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte(`{"server_url":"wss://example.com/agent","agent_name":"nas"}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NAVLOOM_AGENT_NAME", "overridden")
	t.Setenv("NAVLOOM_SERVER_URL", "wss://cloud.example.com/agent")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentName != "overridden" || cfg.ServerURL != "wss://cloud.example.com/agent" {
		t.Fatalf("unexpected config override: %+v", cfg)
	}
}

func TestLoadRejectsUnknownJSONField(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte(`{"server_url":"wss://example.com/agent","secret":"no"}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NAVLOOM_SERVER_URL", "")
	_, err := Load(path)
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected unknown field error, got %v", err)
	}
}

func TestRemoteComposeRequiresExplicitPrivateRootAndOptIn(t *testing.T) {
	cfg := Config{ServerURL: "wss://example.com/agent", AgentName: "nas"}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	cfg.EnableComposeDeploy = true
	if err := cfg.Validate(); err == nil {
		t.Fatal("remote deployment enabled without private root")
	}
	cfg.DeployRoot = "/var/lib/navloom/deployments"
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	cfg.DeployRoot = "../escape"
	if err := cfg.Validate(); err == nil {
		t.Fatal("relative deployment root accepted")
	}
	cfg.DeployRoot = "/"
	if err := cfg.Validate(); err == nil {
		t.Fatal("root filesystem accepted")
	}
	cfg.DeployRoot = "/var/lib/navloom/deployments"
	t.Setenv("NAVLOOM_AGENT_ENABLE_COMPOSE_DEPLOY", "invalid")
	if _, err := Load(""); err == nil {
		t.Fatal("invalid remote execution opt-in accepted")
	}
}
