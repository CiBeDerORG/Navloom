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

func TestSharedHeartbeatFixtures(t *testing.T) {
	_, payload, err := DecodeHeartbeat(fixture(t, "heartbeat.valid.json"))
	if err != nil {
		t.Fatal(err)
	}
	if payload.UptimeSeconds != 30 {
		t.Fatalf("unexpected uptime: %d", payload.UptimeSeconds)
	}
	if _, _, err := DecodeHeartbeat(fixture(t, "heartbeat.invalid-version.json")); err == nil {
		t.Fatal("invalid version should be rejected")
	}
}

func TestNewHeartbeatRoundTrip(t *testing.T) {
	message, err := NewHeartbeat("agent-1", 42)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	_, payload, err := DecodeHeartbeat(data)
	if err != nil {
		t.Fatal(err)
	}
	if payload.UptimeSeconds != 42 {
		t.Fatalf("unexpected uptime: %d", payload.UptimeSeconds)
	}
}

func TestHeartbeatRejectsUnknownFields(t *testing.T) {
	data := []byte(`{"protocol_version":1,"message_id":"4b0182c1-9312-4a42-a816-24fdfda39b55","agent_id":"agent-1","sent_at":"2026-10-11T12:00:00Z","type":"heartbeat","payload":{"uptime_seconds":30,"shell":"evil"}}`)
	if _, _, err := DecodeHeartbeat(data); err == nil {
		t.Fatal("unknown payload fields must be rejected")
	}
}
