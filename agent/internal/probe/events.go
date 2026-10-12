package probe

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"time"
)

// WatchDockerEvents listens to the local read-only Docker events stream.
// It is called exclusively inside an authenticated Agent WSS lifetime;
// no Server or remote TCP connection is initiated by this function.
func WatchDockerEvents(ctx context.Context, notify func()) error {
	socket, err := inventorySocket()
	if err != nil {
		return err
	}
	return watchDockerEventsAt(ctx, socket, notify)
}

func watchDockerEventsAt(ctx context.Context, socket string, notify func()) error {
	info, err := os.Stat(socket)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return errors.New("Docker event socket unavailable")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/events", nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Transport: transport}).Do(request)
	if err != nil {
		return errors.New("Docker event stream unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("Docker event stream rejected")
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 16*1024)
	latest := time.Time{}
	for scanner.Scan() {
		var event struct {
			Type   string `json:"Type"`
			Action string `json:"Action"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) != nil || event.Type != "container" {
			continue
		}
		switch event.Action {
		case "create", "start", "stop", "die", "destroy", "rename", "pause", "unpause", "restart", "update":
			if time.Since(latest) >= 500*time.Millisecond {
				latest = time.Now()
				notify()
			}
		}
	}
	if ctx.Err() != nil {
		return nil
	}
	if err := scanner.Err(); err != nil {
		return errors.New("Docker event stream interrupted")
	}
	return errors.New("Docker event stream closed")
}
