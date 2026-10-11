package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	path := filepath.Join("..", "..", "..", "packages", "contracts", "fixtures", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestHelloFixtureAndProtocolVersion(t *testing.T) {
	var msg Message
	if err := strictJSON(fixture(t, "hello.valid.json"), &msg); err != nil {
		t.Fatal(err)
	}
	if msg.ProtocolVersion != Version || msg.Type != "hello" {
		t.Fatalf("expected v2 hello, got %+v", msg)
	}
	var invalid Message
	if err := strictJSON(fixture(t, "hello.invalid-version.json"), &invalid); err != nil {
		t.Fatal(err)
	}
	if invalid.ProtocolVersion == Version {
		t.Fatal("old v1 is not a current protocol")
	}
}

func TestNewHelloAndResultNeverSendHeartbeat(t *testing.T) {
	msg, err := NewHello(validAgent, "m2")
	if err != nil {
		t.Fatal(err)
	}
	if msg.Type != "hello" || msg.ProtocolVersion != Version {
		t.Fatal("invalid hello")
	}
	result, err := NewCapabilityResult(validAgent, validTask, Capabilities{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Type != "task_result" || result.ProtocolVersion != Version {
		t.Fatal("invalid task result")
	}
	for _, value := range []Message{msg, result} {
		raw, err := json.Marshal(value)
		if err != nil {
		t.Fatal(err)
	}
		if len(raw) == 0 {
			t.Fatal("empty message")
		}
	}
	if _, err := NewHello("agent-1", "m2"); err == nil {
		t.Fatal("must reject invalid agent ID")
	}
}
