package probe

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

func validContainerID(id string) bool {
	if len(id) < 12 || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if c < '0' || c > '9' && c < 'a' || c > 'f' {
			return false
		}
	}
	return true
}

func dockerClientAt(socket string) (*http.Client, func(), error) {
	info, err := os.Stat(socket)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return nil, nil, errors.New("Docker Unix socket unavailable")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives: true,
	}
	return &http.Client{Transport: transport}, transport.CloseIdleConnections, nil
}

// ControlContainer is only invoked by authenticated, administrator-issued
// task_dispatch operations after durable at-most-once journal reservation.
func ControlContainer(ctx context.Context, operation, containerID string) error {
	socket, err := inventorySocket()
	if err != nil {
		return err
	}
	return controlContainerAt(ctx, socket, operation, containerID)
}

func controlContainerAt(ctx context.Context, socket, operation, containerID string) error {
	if !validContainerID(containerID) {
		return errors.New("invalid Docker container ID")
	}
	path := ""
	switch operation {
	case "container_start":
		path = "start"
	case "container_stop":
		path = "stop?t=10"
	case "container_restart":
		path = "restart?t=10"
	default:
		return errors.New("Docker operation not allowed")
	}
	client, cleanup, err := dockerClientAt(socket)
	if err != nil {
		return err
	}
	defer cleanup()
	taskCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(taskCtx, http.MethodPost, "http://docker/containers/"+containerID+"/"+path, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("Docker operation request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent && response.StatusCode != http.StatusNotModified {
		return errors.New("Docker operation was rejected")
	}
	return nil
}

// ReadContainerLogs returns a bounded, read-only snapshot. This API never
// follows logs indefinitely and never allows arbitrary Docker URL parameters.
func ReadContainerLogs(ctx context.Context, containerID string) ([]string, error) {
	socket, err := inventorySocket()
	if err != nil {
		return nil, err
	}
	return readContainerLogsAt(ctx, socket, containerID)
}

func readContainerLogsAt(ctx context.Context, socket, containerID string) ([]string, error) {
	if !validContainerID(containerID) {
		return nil, errors.New("invalid container ID")
	}
	client, cleanup, err := dockerClientAt(socket)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(readCtx, http.MethodGet,
		"http://docker/containers/"+containerID+"/logs?stdout=1&stderr=1&tail=100&timestamps=1", nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("Docker logs unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("Docker logs request denied")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(data) > 64*1024 {
		return nil, errors.New("Docker logs exceed safety limit")
	}
	var plain bytes.Buffer
	// Docker's non-TTY stream includes 8-byte multiplexing headers.
	for offset := 0; offset+8 <= len(data); {
		if data[offset] != 1 && data[offset] != 2 ||
			data[offset+1] != 0 || data[offset+2] != 0 || data[offset+3] != 0 {
			break
		}
		length := int(binary.BigEndian.Uint32(data[offset+4 : offset+8]))
		if length > len(data)-offset-8 {
			break
		}
		plain.Write(data[offset+8 : offset+8+length])
		offset += 8 + length
		if offset == len(data) {
			data = plain.Bytes()
			break
		}
	}
	content := strings.ToValidUTF8(string(data), "")
	raw := strings.Split(strings.ReplaceAll(content, "\r", ""), "\n")
	lines := make([]string, 0, 100)
	for _, line := range raw {
		if len(line) == 0 {
			continue
		}
		if len(line) > 512 {
			line = strings.ToValidUTF8(line[:512], "")
		}
		lines = append(lines, line)
		if len(lines) == 100 {
			break
		}
	}
	return lines, nil
}
