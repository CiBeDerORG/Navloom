package transport

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOperationJournalSurvivesRestartAndPreventsReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operation-journal.jsonl")
	journal, err := openOperationJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	entry := journalEntry{
		TaskID: "de57a2f3-38da-4cb7-a676-81b3950b9701",
		Operation: "container_restart",
		ContainerID: strings.Repeat("a", 64),
	}
	claimed, err := journal.claim(entry)
	if err != nil || !claimed {
		t.Fatalf("could not durably claim first operation: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("journal permissions are too broad: %o", info.Mode().Perm())
	}
	claimed, err = journal.claim(entry)
	if err != nil || claimed {
		t.Fatalf("same process replay was accepted: claimed=%v err=%v", claimed, err)
	}
	restarted, err := openOperationJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err = restarted.claim(entry)
	if err != nil || claimed {
		t.Fatalf("Agent restart replay was accepted: claimed=%v err=%v", claimed, err)
	}
}

func TestOperationJournalFailsClosedOnCorruptionAndUnsafePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unsafe.jsonl")
	if err := os.WriteFile(path, []byte("{bad\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := openOperationJournal(path); err == nil {
		t.Fatal("corrupt journal was accepted")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := openOperationJournal(path); err == nil {
		t.Fatal("world-readable operation journal was accepted")
	}
}
