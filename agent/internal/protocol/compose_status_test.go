package protocol

import (
	"encoding/json"
	"testing"
)

func TestComposeStatusIsStrictReadOnlyTask(t *testing.T) {
	installID := "bad72d8a-cc17-46f1-9ada-b19481a832ea"
	received, err := DecodeTaskDispatch(taskJSON(validAgent, "compose_status",
		map[string]any{"install_task_id": installID}), validAgent)
	if err != nil || TaskOperation(received) != "compose_status" || TaskInstallID(received) != installID {
		t.Fatalf("valid Compose status query rejected: %v", err)
	}
	for _, args := range []map[string]any{
		{}, {"install_task_id": "../escape"},
		{"install_task_id": installID, "command": "sh"},
		{"install_task_id": installID, "compose": "{}"},
	} {
		if _, err := DecodeTaskDispatch(taskJSON(validAgent, "compose_status", args), validAgent); err == nil {
			t.Fatalf("unsafe Compose status query accepted: %+v", args)
		}
	}
	for _, op := range []string{"compose_deploy", "shell", "compose_up", "compose_exec"} {
		if _, err := DecodeTaskDispatch(taskJSON(validAgent, op, map[string]any{}), validAgent); err == nil {
			t.Fatalf("unsafe Compose execution enabled by query support: %s", op)
		}
	}
}

func TestComposeStatusResultIsDistinctFromDeploymentExit(t *testing.T) {
	installID := "bad72d8a-cc17-46f1-9ada-b19481a832ea"
	code := 0
	result, err := NewComposeStatusResult(validAgent, validTask, installID, "succeeded",
		"navloom-nginx-abcd1234", &code)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Success bool `json:"success"`
		ExitCode *int `json:"exit_code"`
		InstallReceipt struct {
			InstallTaskID string `json:"install_task_id"`
			Status string `json:"status"`
			ExitCode *int `json:"exit_code"`
		} `json:"install_receipt"`
	}
	if err := json.Unmarshal(result.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Success || payload.ExitCode != nil ||
		payload.InstallReceipt.InstallTaskID != installID || payload.InstallReceipt.Status != "succeeded" ||
		payload.InstallReceipt.ExitCode == nil || *payload.InstallReceipt.ExitCode != 0 {
		t.Fatalf("invalid status result envelope: %+v", payload)
	}
	for _, status := range []string{"failed", "unknown", "not_found", "up"} {
		if _, err := NewComposeStatusResult(validAgent, validTask, installID, status, "", &code); err == nil {
			t.Fatalf("invalid status/exit pair accepted: %s", status)
		}
	}
}
