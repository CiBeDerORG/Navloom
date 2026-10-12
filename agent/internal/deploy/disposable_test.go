package deploy

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Runs only with the ephemeral Docker fixture image built on GitHub-hosted CI.
// Never invoke this test against an operator's NAS or a custom Docker daemon.
func TestDisposableComposeV2RealDocker(t *testing.T) {
	image := os.Getenv("NAVLOOM_CI_IMAGE")
	if os.Getenv("GITHUB_ACTIONS") != "true" ||
		os.Getenv("NAVLOOM_CI_DOCKER_FIXTURES") != "1" ||
		os.Getenv("DOCKER_HOST") != "" ||
		!regexp.MustCompile(`^navloom-m2-ci:[0-9]+-[0-9]+$`).MatchString(image) {
		t.Skip("real Docker test is restricted to disposable GitHub Actions fixtures")
	}
	root := filepath.Join(t.TempDir(), "deployments")
	project := "navloom-citest-" + strings.ReplaceAll(time.Now().UTC().Format("150405.000000"), ".", "")
	spec := Manifest{
		Name: project,
		Services: map[string]Service{"fixture":{Image:image, Restart:"unless-stopped"}},
	}
	raw, err := json.Marshal(spec)
	if err != nil { t.Fatal(err) }
	id := "a1111111-1111-4111-8111-111111111111"
	code, err := (Executor{Root:root}).Execute(context.Background(), id, raw)
	if err != nil || code != 0 { t.Fatalf("real Docker Compose up failed: code=%d err=%v", code, err) }
	manifestPath := filepath.Join(root, project, "compose.json")
	t.Cleanup(func(){
		cmd := exec.Command("docker", "compose", "-p", project, "-f", manifestPath, "down", "--remove-orphans")
		if result, err := cmd.CombinedOutput(); err != nil {
			t.Errorf("failed to clean disposable Compose project: %v %s", err, string(result))
		}
	})
	active := exec.Command("docker", "compose", "-p", project, "-f", manifestPath, "ps", "-q", "fixture")
	out, err := active.Output()
	if err != nil || strings.TrimSpace(string(out)) == "" { t.Fatalf("disposable fixture is not running: %v", err) }
	if _, err := (Executor{Root:root}).Execute(context.Background(), id, raw); err != ErrAlreadyClaimed {
		t.Fatalf("same task ID replay must not run Docker twice: %v", err)
	}
	t.Log("M3 disposable Go Compose v2 executor PASS: actual up -d, private file, replay denied and cleanup scheduled")
}
