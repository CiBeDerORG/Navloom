package deploy

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setupReceiptTest(t *testing.T, exit int) Executor {
	t.Helper()
	base := t.TempDir()
	bin := filepath.Join(base, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nexit " + stringExitCode(exit) + "\n"
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return Executor{Root: filepath.Join(base, "deployments")}
}

func stringExitCode(code int) string {
	if code == 0 {
		return "0"
	}
	return "17"
}

func TestReconcileOnlyTrustsDurablyRecordedExit(t *testing.T) {
	t.Run("completed", func(t *testing.T) {
		executor := setupReceiptTest(t, 0)
		taskID := "11111111-1111-4111-8111-111111111111"
		raw := trustedManifest("navloom-receipt-abcdefgh")
		code, err := executor.Execute(context.Background(), taskID, raw)
		if code != 0 || err != nil {
			t.Fatalf("expected Compose success: %d %v", code, err)
		}
		result, err := (Executor{Root: executor.Root}).Reconcile(taskID)
		if err != nil || result.Status != "succeeded" || result.ExitCode == nil || *result.ExitCode != 0 {
			t.Fatalf("incorrect persisted success: %#v %v", result, err)
		}
		file, err := os.ReadFile(resultPath(executor.Root, taskID))
		if err != nil || strings.Contains(string(file), "private-canary") {
			t.Fatal("result receipt included secret Compose environment data")
		}
		absent, err := executor.Reconcile("99999999-9999-4999-8999-999999999999")
		if err != nil || absent.Status != "not_found" || absent.ExitCode != nil {
			t.Fatalf("incorrect unknown task status: %#v %v", absent, err)
		}
		if _, err := executor.Execute(context.Background(), taskID, raw); !errors.Is(err, ErrAlreadyClaimed) {
			t.Fatalf("completed task replay executed: %v", err)
		}
	})
	t.Run("failed", func(t *testing.T) {
		executor := setupReceiptTest(t, 17)
		taskID := "22222222-2222-4222-8222-222222222222"
		code, err := executor.Execute(context.Background(), taskID, trustedManifest("navloom-failcase-abcdefgh"))
		if code != 17 || err == nil {
			t.Fatalf("failed Compose exit should be 17: %d %v", code, err)
		}
		result, err := executor.Reconcile(taskID)
		if err != nil || result.Status != "failed" || result.ExitCode == nil || *result.ExitCode != 17 {
			t.Fatalf("incorrect persisted failure: %#v %v", result, err)
		}
	})
}

func TestReconcileIncompleteClaimStaysUnknownAndNeverReexecutes(t *testing.T) {
	executor := setupReceiptTest(t, 0)
	taskID := "33333333-3333-4333-8333-333333333333"
	raw := trustedManifest("navloom-unknowncase-abcdefgh")
	if _, err := executor.executeClaimed(context.Background(), taskID, raw); err != nil {
		t.Fatal(err)
	}
	status, err := (Executor{Root: executor.Root}).Reconcile(taskID)
	if err != nil || status.Status != "unknown" || status.ExitCode != nil {
		t.Fatalf("lost exit record must remain unknown: %#v %v", status, err)
	}
	if _, err := executor.Execute(context.Background(), taskID, raw); !errors.Is(err, ErrAlreadyClaimed) {
		t.Fatalf("unknown task was replayed: %v", err)
	}
	if _, err := os.Stat(resultPath(executor.Root, taskID)); !os.IsNotExist(err) {
		t.Fatal("replay accidentally synthesized a success receipt")
	}
}

func TestReconcileRejectsTamperedOrSymlinkedResult(t *testing.T) {
	executor := setupReceiptTest(t, 0)
	taskID := "44444444-4444-4444-8444-444444444444"
	raw := trustedManifest("navloom-integrity-abcdefgh")
	if _, err := executor.Execute(context.Background(), taskID, raw); err != nil {
		t.Fatal(err)
	}
	file := resultPath(executor.Root, taskID)
	if err := os.WriteFile(file, []byte(`{"task_id":"different","exit_code":0}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := executor.Reconcile(taskID); err == nil {
		t.Fatal("tampered task ID was trusted")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(target, []byte(`{"task_id":"44444444-4444-4444-8444-444444444444","exit_code":0}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, file); err != nil {
		t.Fatal(err)
	}
	if _, err := executor.Reconcile(taskID); err == nil {
		t.Fatal("symlinked exit receipt was trusted")
	}
}
