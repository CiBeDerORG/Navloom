package deploy

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type TaskReceipt struct {
	TaskID   string `json:"task_id"`
	Project  string `json:"project,omitempty"`
	Status   string `json:"status"`
	ExitCode *int   `json:"exit_code,omitempty"`
}

type storedReceipt struct {
	TaskID   string `json:"task_id"`
	ExitCode int    `json:"exit_code"`
}

// Reconcile is side-effect-free: it never starts or retries Docker. A journal
// claim with no durably recorded exit status is UNKNOWN after a crash, a
// timeout, or a Server disconnect, not an assumed failure or success.
func (e Executor) Reconcile(taskID string) (TaskReceipt, error) {
	receipt := TaskReceipt{TaskID: taskID, Status: "not_found"}
	if !uuidPattern.MatchString(taskID) {
		return receipt, errors.New("invalid task ID")
	}
	root := filepath.Clean(e.Root)
	if !filepath.IsAbs(root) || root == "/" || root != e.Root || strings.Contains(root, "..") {
		return receipt, errors.New("invalid deployment root")
	}
	if err := verifyPrivateDir(root); err != nil {
		return receipt, err
	}
	lock, err := openPrivateNoFollow(filepath.Join(root, ".deploy.lock"), syscall.O_RDONLY)
	if err != nil {
		return receipt, errors.New("deployment lock unavailable")
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_SH); err != nil {
		return receipt, errors.New("cannot lock deployment ledger")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	found, err := findClaim(root, taskID)
	if err != nil {
		return receipt, err
	}
	if found == nil {
		return receipt, nil
	}
	receipt.Project, receipt.Status = found.Project, "unknown"
	file, err := openPrivateNoFollow(resultPath(root, taskID), syscall.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		return receipt, nil
	}
	if err != nil {
		return receipt, errors.New("unsafe result receipt")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 2049))
	if err != nil || len(raw) > 2048 {
		return receipt, errors.New("invalid result receipt size")
	}
	var stored storedReceipt
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil || stored.TaskID != taskID || stored.ExitCode < 0 {
		return receipt, errors.New("invalid authenticated deployment result")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return receipt, errors.New("trailing deployment receipt data")
	}
	receipt.ExitCode = &stored.ExitCode
	if stored.ExitCode == 0 {
		receipt.Status = "succeeded"
	} else {
		receipt.Status = "failed"
	}
	return receipt, nil
}

func resultPath(root, taskID string) string {
	return filepath.Join(root, ".result-"+taskID+".json")
}

func findClaim(root, taskID string) (*claim, error) {
	file, err := openPrivateNoFollow(filepath.Join(root, ".claims.jsonl"), syscall.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("unsafe deployment claim ledger")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 2*1024*1024+1))
	if err != nil || len(raw) > 2*1024*1024 {
		return nil, errors.New("claim ledger unreadable")
	}
	var found *claim
	for _, line := range bytes.Split(bytes.TrimSpace(raw), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var row claim
		if json.Unmarshal(line, &row) != nil ||
			!uuidPattern.MatchString(row.TaskID) ||
			!projectPattern.MatchString(row.Project) || len(row.Digest) != 64 {
			return nil, errors.New("corrupted deployment claim")
		}
		if row.TaskID == taskID {
			if found != nil {
				return nil, errors.New("duplicate deployment claim")
			}
			entry := row
			found = &entry
		}
	}
	return found, nil
}

// persistResult runs only after the executor receives an actual CLI exit
// status. The result is a small 0600 file fsync'd before the Server may treat
// it as succeeded/failed; never store stdout, stderr, env or secret inputs.
func (e Executor) persistResult(taskID string, exitCode int) error {
	if exitCode < 0 || !uuidPattern.MatchString(taskID) {
		return errors.New("invalid Compose exit result")
	}
	root := filepath.Clean(e.Root)
	if !filepath.IsAbs(root) || root == "/" || root != e.Root {
		return errors.New("invalid deployment root")
	}
	if err := verifyPrivateDir(root); err != nil {
		return err
	}
	lock, err := openPrivateNoFollow(filepath.Join(root, ".deploy.lock"), syscall.O_RDWR)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if found, err := findClaim(root, taskID); err != nil || found == nil {
		return errors.New("Compose exit has no durable claim")
	}
	file, err := openPrivateNoFollow(resultPath(root, taskID),
		syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL)
	if err != nil {
		return errors.New("deployment result already exists or storage unsafe")
	}
	encoded, err := json.Marshal(storedReceipt{TaskID: taskID, ExitCode: exitCode})
	if err == nil {
		_, err = file.Write(append(encoded, '\n'))
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return errors.New("could not persist result")
	}
	return syncDir(root)
}
