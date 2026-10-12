package probe

import (
	"context"
	"fmt"
	"net/http"
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
		_, _ = fmt.Fprintln(w, `{"Type":"container","Action":"start"}`)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		writes <- struct{}{}
	})
	changed := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- watchDockerEventsAt(ctx, socket, func() {
			select {
			case changed <- struct{}{}:
			default:
			}
		})
	}()
	select {
	case <-changed:
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
