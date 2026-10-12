package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func trustedManifest(project string) []byte {
	data, _ := json.Marshal(Manifest{
		Name: project,
		Services: map[string]Service{
			"database": {
				Image:"postgres:16.8-alpine", Restart:"unless-stopped",
				Environment: map[string]string{"POSTGRES_PASSWORD":"private-canary-123"},
				Volumes: []string{"postgres_data:/var/lib/postgresql/data"},
			},
			"adminer": {
				Image:"adminer:4.8.1", Restart:"unless-stopped",
				Ports: []string{"127.0.0.1:18881:8080/tcp"},
			},
		},
		Volumes: map[string]struct{}{"postgres_data":{}},
	})
	return data
}

func TestStrictManifestRejectsPrivilegedFlagsAndEscapes(t *testing.T) {
	good := trustedManifest("navloom-postgres-adminer-abcd1234")
	if _, err := StrictManifest(good); err != nil { t.Fatal(err) }
	bad := []string{
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped","privileged":true}}}`,
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped","command":"sh -c curl"}}}`,
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped","network_mode":"host"}}}`,
		`{"name":"../escape","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped"}}}`,
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:latest","restart":"unless-stopped"}}}`,
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped","ports":["0.0.0.0:9000:80/tcp"]}}}`,
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped","ports":["127.0.0.1:65536:80/tcp"]}}}`,
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped","volumes":["/var/run/docker.sock:/var/run/docker.sock"]}}}`,
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped","volumes":["cache:/safe/../host"]}},"volumes":{"cache":{}}}`,
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped","environment":{"TOKEN":"a\nb"}}}}`,
		`{"name":"navloom-postgres-adminer-abcd1234","services":{"web":{"image":"nginx:1.27","restart":"unless-stopped"}}} {"garbage":true}`,
	}
	for _, input := range bad {
		if _, err := StrictManifest([]byte(input)); err == nil {
			t.Errorf("accepted unsafe Compose JSON: %s", input)
		}
	}
	huge := make([]byte, 32769)
	if _, err := StrictManifest(huge); err == nil { t.Fatal("accepted oversized manifest") }
}

func TestExecuteNeverReplaysEvenAfterRestartAndUsesFixedCLIArgs(t *testing.T) {
	base := t.TempDir()
	bin := filepath.Join(base, "bin")
	if err := os.Mkdir(bin, 0700); err != nil { t.Fatal(err) }
	logPath := filepath.Join(base, "invocations")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NAVLOOM_TEST_INVOKE\"\nexit \"$NAVLOOM_TEST_EXIT\"\n"
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(script), 0700); err != nil { t.Fatal(err) }
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("NAVLOOM_TEST_INVOKE", logPath)
	t.Setenv("NAVLOOM_TEST_EXIT", "0")
	root := filepath.Join(base, "deployments")
	executor := Executor{Root:root}
	task := "11111111-1111-4111-8111-111111111111"
	raw := trustedManifest("navloom-postgres-adminer-abcd1234")
	exit, err := executor.Execute(context.Background(), task, raw)
	if err != nil || exit != 0 { t.Fatalf("exit=%d err=%v", exit, err) }
	lines, err := os.ReadFile(logPath)
	if err != nil { t.Fatal(err) }
	command := strings.TrimSpace(string(lines))
	expected := "compose -p navloom-postgres-adminer-abcd1234 -f " +
		filepath.Join(root, "navloom-postgres-adminer-abcd1234", "compose.json") + " up -d"
	if command != expected { t.Fatalf("unsafe/incorrect args: %q", command) }
	if strings.Contains(command, "private-canary") { t.Fatal("secret leaked into command line") }
	content, err := os.ReadFile(filepath.Join(root, "navloom-postgres-adminer-abcd1234", "compose.json"))
	if err != nil || !strings.Contains(string(content), "private-canary-123") {
		t.Fatalf("Compose file missing: %v", err)
	}
	for _, item := range []string{root, filepath.Join(root, "navloom-postgres-adminer-abcd1234")} {
		fi, err := os.Stat(item)
		if err != nil || fi.Mode().Perm() != 0700 { t.Fatalf("insecure dir: %s %v", item, err) }
	}
	fi, err := os.Stat(filepath.Join(root, "navloom-postgres-adminer-abcd1234", "compose.json"))
	if err != nil || fi.Mode().Perm() != 0600 { t.Fatalf("insecure Compose file: %v", err) }
	// New executor instance simulates Agent process restart.
	if _, err := (Executor{Root:root}).Execute(context.Background(), task, raw); !errors.Is(err, ErrAlreadyClaimed) {
		t.Fatalf("replay after restart should be blocked: %v", err)
	}
	if _, err := executor.Execute(context.Background(), "22222222-2222-4222-8222-222222222222", raw); !errors.Is(err, ErrProjectUsed) {
		t.Fatalf("second task may not overwrite project: %v", err)
	}
	after, err := os.ReadFile(logPath)
	if err != nil || string(after) != string(lines) { t.Fatal("replay launched a second Docker invocation") }
}

func TestExecutePreservesFailureExitAndRejectsUnsafeRoot(t *testing.T) {
	base := t.TempDir()
	bin := filepath.Join(base, "bin")
	if err := os.Mkdir(bin, 0700); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\nexit 17\n"), 0700); err != nil { t.Fatal(err) }
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	root := filepath.Join(base, "deploy")
	input := trustedManifest("navloom-nginx-01234567")
	task := "33333333-3333-4333-8333-333333333333"
	code, err := (Executor{Root:root}).Execute(context.Background(), task, input)
	if code != 17 || err == nil { t.Fatalf("expected verbatim exit code 17, got %d/%v", code, err) }
	if _, err := (Executor{Root:root}).Execute(context.Background(), task, input); !errors.Is(err, ErrAlreadyClaimed) {
		t.Fatalf("failed task replay was not blocked: %v", err)
	}
	unsafe := filepath.Join(base, "unsafe")
	if err := os.Mkdir(unsafe, 0777); err != nil { t.Fatal(err) }
	if err := os.Chmod(unsafe, 0777); err != nil { t.Fatal(err) }
	if _, err := (Executor{Root:unsafe}).Execute(context.Background(),
		"44444444-4444-4444-8444-444444444444", input); err == nil {
		t.Fatal("world-writable deployment root accepted")
	}
	link := filepath.Join(base, "symlink")
	if err := os.Symlink(root, link); err != nil { t.Fatal(err) }
	if _, err := (Executor{Root:link}).Execute(context.Background(),
		"55555555-5555-4555-8555-555555555555", input); err == nil {
		t.Fatal("symlinked deployment root accepted")
	}
}
