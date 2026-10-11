package protocol

import (
	"encoding/json"
	"testing"
	"time"
)

const validAgent = "4b0182c1-9312-4a42-a816-24fdfda39b55"
const validTask = "de57a2f3-38da-4cb7-a676-81b3950b9701"

func taskJSON(agent, operation string, args any) []byte {
	data, _ := json.Marshal(map[string]any{
		"protocol_version": Version,
		"message_id": "a57be91b-cbf5-4c84-93cb-b07c126bb18a",
		"agent_id": agent,
		"task_id": validTask,
		"sent_at": time.Now().UTC().Format(time.RFC3339),
		"type": "task_dispatch",
		"payload": map[string]any{"operation": operation, "arguments": args},
	})
	return data
}

func TestCapabilityTaskStrictAllowlist(t *testing.T) {
	msg, err := DecodeTaskDispatch(taskJSON(validAgent, "capability_probe", map[string]any{}), validAgent)
	if err != nil || msg.TaskID != validTask {
		t.Fatalf("valid task rejected: %v", err)
	}
	for _, input := range [][]byte{
		taskJSON(validAgent, "shell", map[string]any{"command": "id"}),
		taskJSON(validAgent, "container_start", map[string]any{"container_id": "abc"}),
		taskJSON(validAgent, "compose_deploy", map[string]any{"project": "../etc"}),
		taskJSON(validAgent, "capability_probe", map[string]any{"path": "/tmp"}),
		taskJSON("other-agent", "capability_probe", map[string]any{}),
		[]byte(`{"type":"task_dispatch"}`),
	} {
		if _, err := DecodeTaskDispatch(input, validAgent); err == nil {
			t.Fatalf("unexpected task accepted: %s", input)
		}
	}
}

func TestCapabilityResultHasCorrelatedTaskID(t *testing.T) {
	why := "socket_missing"
	caps := Capabilities{
		Platform: "linux", Architecture: "amd64",
		Docker: DockerCapability{Reason: &why},
		Compose: ComposeCapability{Reason: &why},
	}
	msg, err := NewCapabilityResult(validAgent, validTask, caps)
	if err != nil {
		t.Fatal(err)
	}
	if msg.Type != "task_result" || msg.TaskID != validTask || msg.AgentID != validAgent {
		t.Fatalf("bad result envelope: %+v", msg)
	}
	var body map[string]any
	if err := json.Unmarshal(msg.Payload, &body); err != nil {
		t.Fatal(err)
	}
	if body["success"] != true || body["exit_code"] != nil || body["capabilities"] == nil {
		t.Fatalf("bad task result: %+v", body)
	}
}
