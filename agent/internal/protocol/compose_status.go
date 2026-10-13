package protocol

import (
	"encoding/json"
	"errors"
)

// TaskInstallID is only called after DecodeTaskDispatch has verified the
// Server's authenticated command envelope and exact argument allowlist.
func TaskInstallID(task Message) string {
	var payload struct {
		Arguments struct {
			InstallTaskID string `json:"install_task_id"`
		} `json:"arguments"`
	}
	if json.Unmarshal(task.Payload, &payload) != nil {
		return ""
	}
	return payload.Arguments.InstallTaskID
}

// NewComposeStatusResult reports a side-effect-free durable receipt.
// "success" means the read-only query succeeded; it does NOT mean the
// installation succeeded. Install status and exit_code are independent.
func NewComposeStatusResult(agentID, queryTaskID, installTaskID, status, project string, exitCode *int) (Message, error) {
	if !uuidPattern.MatchString(queryTaskID) || !uuidPattern.MatchString(installTaskID) {
		return Message{}, errors.New("invalid task identity")
	}
	switch status {
	case "not_found", "unknown":
		if exitCode != nil {
			return Message{}, errors.New("unknown receipt cannot claim an exit code")
		}
	case "succeeded":
		if exitCode == nil || *exitCode != 0 {
			return Message{}, errors.New("Compose success needs exit code zero")
		}
	case "failed":
		if exitCode == nil || *exitCode <= 0 {
			return Message{}, errors.New("Compose failure needs nonzero exit")
		}
	default:
		return Message{}, errors.New("invalid Compose receipt status")
	}
	if len(project) > 63 {
		return Message{}, errors.New("invalid project in status")
	}
	msg, err := newEnvelope(agentID)
	if err != nil {
		return Message{}, err
	}
	payload, err := json.Marshal(struct {
		Success       bool `json:"success"`
		ExitCode      *int `json:"exit_code"`
		InstallReceipt struct {
			InstallTaskID string `json:"install_task_id"`
			Status        string `json:"status"`
			Project       string `json:"project"`
			ExitCode      *int `json:"exit_code"`
		} `json:"install_receipt"`
	}{
		Success: true,
		InstallReceipt: struct {
			InstallTaskID string `json:"install_task_id"`
			Status        string `json:"status"`
			Project       string `json:"project"`
			ExitCode      *int `json:"exit_code"`
		}{InstallTaskID: installTaskID, Status: status, Project: project, ExitCode: exitCode},
	})
	if err != nil {
		return Message{}, err
	}
	msg.Type, msg.TaskID, msg.Payload = "task_result", queryTaskID, payload
	return msg, nil
}
