package probe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/protocol"
)

const maxDockerInventory = 2000

type dockerContainer struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
	Image string   `json:"Image"`
	State string   `json:"State"`
	Ports []struct {
		PrivatePort int    `json:"PrivatePort"`
		PublicPort  int    `json:"PublicPort"`
		Type        string `json:"Type"`
		IP          string `json:"IP"`
	} `json:"Ports"`
	Labels map[string]string `json:"Labels"`
}

func inventorySocket() (string, error) {
	switch os.Getenv("DOCKER_HOST") {
	case "", "unix:///var/run/docker.sock":
		return "/var/run/docker.sock", nil
	case "unix:///run/docker.sock":
		return "/run/docker.sock", nil
	default:
		return "", errors.New("unsupported Docker host")
	}
}

func shortText(s string, n int) string {
	s = strings.ToValidUTF8(strings.TrimSpace(s), "")
	if len(s) > n {
		s = s[:n]
		s = strings.ToValidUTF8(s, "")
	}
	return s
}

func isHexID(s string) bool {
	if len(s) < 12 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' && c < 'a' || c > 'f' {
			return false
		}
	}
	return true
}

// ListContainers fetches a complete bounded all=true snapshot, including
// containers existing before the Agent booted. No Docker writes, shell or
// user-supplied socket/endpoint are possible.
func ListContainers(ctx context.Context) ([]protocol.ContainerRecord, error) {
	socket, err := inventorySocket()
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(socket)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return nil, errors.New("Docker Unix socket unavailable")
	}
	queryCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(queryCtx, http.MethodGet, "http://docker/containers/json?all=1", nil)
	if err != nil {
		return nil, err
	}
	response, err := (&http.Client{Transport: transport}).Do(request)
	if err != nil {
		return nil, errors.New("Docker inventory request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("Docker inventory unavailable")
	}
	limited := io.LimitReader(response.Body, 8*1024*1024+1)
	data, err := io.ReadAll(limited)
	if err != nil || len(data) > 8*1024*1024 {
		return nil, errors.New("Docker inventory response too large")
	}
	var source []dockerContainer
	if err := json.Unmarshal(data, &source); err != nil {
		return nil, errors.New("invalid Docker inventory response")
	}
	if len(source) > maxDockerInventory {
		return nil, fmt.Errorf("Docker inventory exceeds %d containers", maxDockerInventory)
	}
	items := make([]protocol.ContainerRecord, 0, len(source))
	for _, item := range source {
		id := strings.ToLower(item.ID)
		if !isHexID(id) {
			return nil, errors.New("Docker inventory returned an invalid container ID")
		}
		name := id[:12]
		if len(item.Names) > 0 {
			name = shortText(strings.TrimPrefix(item.Names[0], "/"), 255)
		}
		if name == "" {
			name = id[:12]
		}
		image := shortText(item.Image, 512)
		if image == "" {
			image = "unknown"
		}
		state := item.State
		switch state {
		case "running", "exited", "paused", "restarting", "created", "dead":
		default:
			state = "unknown"
		}
		ports := make([]protocol.ContainerPort, 0)
		for _, port := range item.Ports {
			if len(ports) >= 128 {
				break
			}
			if port.PrivatePort < 1 || port.PrivatePort > 65535 {
				continue
			}
			if port.Type != "tcp" && port.Type != "udp" && port.Type != "sctp" {
				continue
			}
			entry := protocol.ContainerPort{PrivatePort: port.PrivatePort, Protocol: port.Type}
			if port.PublicPort >= 1 && port.PublicPort <= 65535 {
				value := port.PublicPort
				entry.PublicPort = &value
			}
			if port.IP != "" {
				ip := shortText(port.IP, 64)
				entry.IP = &ip
			}
			ports = append(ports, entry)
		}
		labels := make(map[string]string)
		var project, service *string
		for _, field := range []string{"com.docker.compose.project", "com.docker.compose.service"} {
			if value, ok := item.Labels[field]; ok {
				clean := shortText(value, 128)
				labels[field] = clean
				if field == "com.docker.compose.project" {
					project = &clean
				} else {
					service = &clean
				}
			}
		}
		items = append(items, protocol.ContainerRecord{
			ContainerID: id, Name: name, Image: image, State: state, Ports: ports, Labels: labels,
			ComposeProject: project, ComposeService: service,
		})
	}
	return items, nil
}
