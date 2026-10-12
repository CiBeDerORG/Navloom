package protocol

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"
)

const Version = 2

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type Message struct {
	ProtocolVersion int             `json:"protocol_version"`
	MessageID       string          `json:"message_id"`
	AgentID         string          `json:"agent_id"`
	SentAt          string          `json:"sent_at"`
	Type            string          `json:"type"`
	TaskID          string          `json:"task_id,omitempty"`
	Payload         json.RawMessage `json:"payload"`
}

// A message envelope is generated only for explicit hello/task responses.
func newEnvelope(agentID string) (Message, error) {
	if !uuidPattern.MatchString(agentID) {
		return Message{}, errors.New("invalid Agent ID")
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return Message{}, fmt.Errorf("generate message ID: %w", err)
	}
	random[6] = (random[6] & 0x0f) | 0x40
	random[8] = (random[8] & 0x3f) | 0x80
	id := fmt.Sprintf("%x-%x-%x-%x-%x", random[0:4], random[4:6], random[6:8], random[8:10], random[10:16])
	return Message{ProtocolVersion: Version, MessageID: id, AgentID: agentID,
		SentAt: time.Now().UTC().Format(time.RFC3339)}, nil
}

func strictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("expected exactly one JSON object")
	}
	return nil
}

func NewHello(agentID, version string) (Message, error) {
	if version == "" {
		return Message{}, errors.New("Agent version is required")
	}
	message, err := newEnvelope(agentID)
	if err != nil {
		return Message{}, err
	}
	payload, err := json.Marshal(struct {
		Version string `json:"version"`
	}{Version: version})
	if err != nil {
		return Message{}, err
	}
	message.Type = "hello"
	message.Payload = payload
	return message, nil
}

type CapabilityState struct {
	Available  bool    `json:"available"`
	APIVersion *string `json:"api_version,omitempty"`
	Version    *string `json:"version,omitempty"`
	Reason     *string `json:"reason"`
}

type DockerCapability struct {
	Available  bool    `json:"available"`
	APIVersion *string `json:"api_version"`
	Reason     *string `json:"reason"`
}

type ComposeCapability struct {
	Available bool    `json:"available"`
	Version   *string `json:"version"`
	Reason    *string `json:"reason"`
}

type Capabilities struct {
	Platform     string            `json:"platform"`
	Architecture string            `json:"architecture"`
	Docker       DockerCapability  `json:"docker"`
	Compose      ComposeCapability `json:"compose"`
}

type taskDispatchPayload struct {
	Operation string          `json:"operation"`
	Arguments json.RawMessage `json:"arguments"`
}

// DecodeTaskDispatch permits exactly one read-only command. Future Docker
// operations require a separate reviewed allowlist and executor.
func DecodeTaskDispatch(data []byte, expectedAgentID string) (Message, error) {
	var msg Message
	if len(data) > 64*1024 {
		return msg, errors.New("message too large")
	}
	if err := strictJSON(data, &msg); err != nil {
		return msg, errors.New("invalid task envelope")
	}
	if msg.ProtocolVersion != Version || !uuidPattern.MatchString(msg.MessageID) ||
		!uuidPattern.MatchString(msg.TaskID) || msg.AgentID != expectedAgentID ||
		msg.Type != "task_dispatch" {
		return msg, errors.New("task envelope rejected")
	}
	if _, err := time.Parse(time.RFC3339, msg.SentAt); err != nil {
		return msg, errors.New("invalid task timestamp")
	}
	var payload taskDispatchPayload
	if err := strictJSON(msg.Payload, &payload); err != nil {
		return msg, errors.New("invalid task payload")
	}
	if payload.Operation != "capability_probe" && payload.Operation != "inventory_refresh" {
		return msg, errors.New("operation not enabled")
	}
	var args struct{}
	if err := strictJSON(payload.Arguments, &args); err != nil {
		return msg, errors.New("read-only task takes no arguments")
	}
	return msg, nil
}

func NewCapabilityResult(agentID, taskID string, capabilities Capabilities) (Message, error) {
	if !uuidPattern.MatchString(taskID) {
		return Message{}, errors.New("invalid task ID")
	}
	msg, err := newEnvelope(agentID)
	if err != nil {
		return Message{}, err
	}
	payload, err := json.Marshal(struct {
		Success      bool         `json:"success"`
		ExitCode     *int         `json:"exit_code"`
		Capabilities Capabilities `json:"capabilities"`
	}{Success: true, Capabilities: capabilities})
	if err != nil {
		return Message{}, err
	}
	msg.Type = "task_result"
	msg.TaskID = taskID
	msg.Payload = payload
	return msg, nil
}

type ContainerPort struct {
	PrivatePort int     `json:"private_port"`
	PublicPort  *int    `json:"public_port"`
	Protocol    string  `json:"protocol"`
	IP          *string `json:"ip"`
}

type ContainerRecord struct {
	ContainerID    string            `json:"container_id"`
	Name           string            `json:"name"`
	Image          string            `json:"image"`
	State          string            `json:"state"`
	Ports          []ContainerPort   `json:"ports"`
	Labels         map[string]string `json:"labels"`
	ComposeProject *string           `json:"compose_project"`
	ComposeService *string           `json:"compose_service"`
}

// TaskOperation is invoked only after the strict envelope and allowlist validate.
func TaskOperation(msg Message) string {
	var payload taskDispatchPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return ""
	}
	return payload.Operation
}

func NewInventoryChunk(agentID, taskID string, sequence int, records []ContainerRecord) (Message, error) {
	if !uuidPattern.MatchString(taskID) || sequence < 0 || sequence >= 100 || len(records) > 20 {
		return Message{}, errors.New("invalid inventory chunk")
	}
	msg, err := newEnvelope(agentID)
	if err != nil {
		return Message{}, err
	}
	payload, err := json.Marshal(struct {
		Sequence int               `json:"sequence"`
		Records  []ContainerRecord `json:"containers"`
	}{Sequence: sequence, Records: records})
	if err != nil {
		return Message{}, err
	}
	msg.Type, msg.TaskID, msg.Payload = "inventory_chunk", taskID, payload
	return msg, nil
}

func NewInventoryResult(agentID, taskID string, count, chunks int) (Message, error) {
	if !uuidPattern.MatchString(taskID) || count < 0 || count > 2000 || chunks < 0 || chunks > 100 {
		return Message{}, errors.New("invalid inventory completion")
	}
	msg, err := newEnvelope(agentID)
	if err != nil {
		return Message{}, err
	}
	payload, err := json.Marshal(struct {
		Success  bool `json:"success"`
		ExitCode *int `json:"exit_code"`
		Count    int  `json:"inventory_count"`
		Chunks   int  `json:"inventory_chunks"`
	}{Success: true, Count: count, Chunks: chunks})
	if err != nil {
		return Message{}, err
	}
	msg.Type, msg.TaskID, msg.Payload = "task_result", taskID, payload
	return msg, nil
}

func NewTaskFailure(agentID, taskID string, detail string) (Message, error) {
	if !uuidPattern.MatchString(taskID) {
		return Message{}, errors.New("invalid task ID")
	}
	msg, err := newEnvelope(agentID)
	if err != nil {
		return Message{}, err
	}
	if len(detail) > 200 {
		detail = detail[:200]
	}
	if detail == "" {
		detail = "operation unavailable"
	}
	code := 1
	payload, err := json.Marshal(struct {
		Success  bool   `json:"success"`
		ExitCode *int   `json:"exit_code"`
		Error    string `json:"error"`
	}{Success: false, ExitCode: &code, Error: detail})
	if err != nil {
		return Message{}, err
	}
	msg.Type, msg.TaskID, msg.Payload = "task_result", taskID, payload
	return msg, nil
}

func NewInventoryChanged(agentID string) (Message, error) {
	msg, err := newEnvelope(agentID)
	if err != nil {
		return Message{}, err
	}
	msg.Type = "inventory_changed"
	msg.Payload = json.RawMessage(`{"resource":"containers"}`)
	return msg, nil
}
