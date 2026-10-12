package probe

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestDockerEventsProduceOnlyContainerChangeNotifications(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writes := make(chan struct{}, 1)
	socket := mockDockerSocket(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/events" {
			t.Errorf("unexpected event stream API: %s %s", r.Method, r.URL.Path)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintln(w, `{"Type":"network","Action":"connect"}`)
		_, _ = fmt.Fprintf(w, "{\"Type\":\"container\",\"Action\":\"start\",\"Actor\":{\"ID\":\"%s\"}}\n", strings.Repeat("a", 64))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		writes <- struct{}{}
	})
	changed := make(chan ContainerEvent, 1)
	done := make(chan error, 1)
	go func() {
		done <- watchDockerEventsAt(ctx, socket, func(event ContainerEvent) {
			select {
			case changed <- event:
			default:
			}
		})
	}()
	select {
	case event := <-changed:
		if event.ContainerID != strings.Repeat("a", 64) || event.Action != "start" {
			t.Fatalf("invalid Docker event: %+v", event)
		}
		cancel()
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("Docker container event did not trigger a refresh hint")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("event watcher did not close after context cancel: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Docker event watcher did not stop on disconnect")
	}
}

func TestDockerEventsDoNotDropRapidTransitions(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	firstID := strings.Repeat("a", 64)
	secondID := strings.Repeat("b", 64)
	socket := mockDockerSocket(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/events" {
			t.Errorf("unexpected event API: %s %s", r.Method, r.URL.Path)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintln(w, "{\"Type\":\"network\",\"Action\":\"connect\"}")
		_, _ = fmt.Fprintln(w, "{\"Type\":\"container\",\"Action\":\"start\",\"Actor\":{\"ID\":\"not-a-container-id\"}}")
		for _, item := range []struct{ id, action string }{
			{firstID, "start"}, {firstID, "stop"}, {secondID, "destroy"},
		} {
			_, _ = fmt.Fprintf(w, "{\"Type\":\"container\",\"Action\":\"%s\",\"Actor\":{\"ID\":\"%s\"}}\n", item.action, item.id)
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	changed := make(chan ContainerEvent, 4)
	done := make(chan error, 1)
	go func() {
		done <- watchDockerEventsAt(ctx, socket, func(event ContainerEvent) {
			changed <- event
		})
	}()
	want := []ContainerEvent{
		{ContainerID: firstID, Action: "start"},
		{ContainerID: firstID, Action: "stop"},
		{ContainerID: secondID, Action: "destroy"},
	}
	for i, expected := range want {
		select {
		case got := <-changed:
			if got != expected {
				t.Fatalf("event %d: got %+v, want %+v", i, got, expected)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("event %d was lost during a rapid Docker state transition", i)
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("watcher did not stop on disconnect: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("watcher did not stop when the WSS lifetime ended")
	}
}
