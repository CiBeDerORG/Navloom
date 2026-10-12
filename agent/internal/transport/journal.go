package transport

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
)

const maxJournalEntries = 10000

type journalEntry struct {
	TaskID      string `json:"task_id"`
	Operation   string `json:"operation"`
	ContainerID string `json:"container_id"`
}

type operationJournal struct {
	mu   sync.Mutex
	path string
	seen map[string]journalEntry
}

// Operations are claimed on disk BEFORE touching Docker. On crash or timeout
// an uncertain command is never re-executed automatically, even after restart.
func openOperationJournal(path string) (*operationJournal, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("operation journal requires a persistent file")
	}
	journal := &operationJournal{path: path, seen: make(map[string]journalEntry)}
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return nil, errors.New("operation journal must be a private regular file")
		}
		file, err := os.Open(path)
		if err != nil {
			return nil, errors.New("cannot read operation journal")
		}
		defer file.Close()
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 4096), 4096)
		for scanner.Scan() {
			var entry journalEntry
			if json.Unmarshal(scanner.Bytes(), &entry) != nil || entry.TaskID == "" ||
				entry.Operation == "" || entry.ContainerID == "" {
				return nil, errors.New("operation journal corrupted; refusing Docker controls")
			}
			if _, found := journal.seen[entry.TaskID]; found {
				return nil, errors.New("duplicate operation journal entry")
			}
			journal.seen[entry.TaskID] = entry
			if len(journal.seen) > maxJournalEntries {
				return nil, errors.New("operation journal capacity exceeded")
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, errors.New("operation journal unreadable")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("cannot stat operation journal")
	}
	return journal, nil
}

func (journal *operationJournal) claim(entry journalEntry) (bool, error) {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if _, seen := journal.seen[entry.TaskID]; seen {
		return false, nil
	}
	if len(journal.seen) >= maxJournalEntries {
		return false, errors.New("operation journal capacity reached")
	}
	file, err := os.OpenFile(journal.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return false, errors.New("cannot persist operation claim")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return false, errors.New("unsafe operation journal permissions")
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return false, err
	}
	if _, err := file.Write(append(raw, '\n')); err != nil {
		return false, errors.New("cannot persist operation claim")
	}
	if err := file.Sync(); err != nil {
		return false, errors.New("cannot sync operation claim")
	}
	journal.seen[entry.TaskID] = entry
	return true, nil
}
