// Package deploy provides the local, fail-closed Compose v2 executor foundation.
// It is deliberately NOT exposed through Agent WSS until M3 protocol review.
package deploy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

var (
	ErrAlreadyClaimed = errors.New("deployment task already claimed; never execute twice")
	ErrProjectUsed    = errors.New("Compose project already claimed by another task")
	projectPattern    = regexp.MustCompile(`^navloom-[a-z][a-z0-9-]{1,47}-[a-z0-9]{8,24}$`)
	namePattern       = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,47}$`)
	imagePattern      = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{2,299}$`)
	portPattern       = regexp.MustCompile(`^127\.0\.0\.1:[0-9]{1,5}:[0-9]{1,5}/(tcp|udp)$`)
	envPattern        = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)
	uuidPattern       = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

type Service struct {
	Image       string            `json:"image"`
	Restart     string            `json:"restart"`
	Ports       []string          `json:"ports,omitempty"`
	Environment map[string]string `json:"environment,omitempty"`
	Volumes     []string          `json:"volumes,omitempty"`
}
type Manifest struct {
	Name     string              `json:"name"`
	Services map[string]Service  `json:"services"`
	Volumes  map[string]struct{} `json:"volumes,omitempty"`
}
type claim struct {
	TaskID  string `json:"task_id"`
	Project string `json:"project"`
	Digest  string `json:"digest"`
}

// StrictManifest accepts only the safe Compose subset emitted by the Server.
// Unknown Docker privileges, arbitrary mounts, host network, shell commands,
// devices, build contexts or unsafe images are rejected, never ignored.
func StrictManifest(raw []byte) (Manifest, error) {
	var result Manifest
	if len(raw) == 0 || len(raw) > 32*1024 {
		return result, errors.New("Compose manifest exceeds 32 KiB or is empty")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return result, errors.New("invalid Compose structure")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return result, errors.New("multiple Compose JSON values")
	}
	if !projectPattern.MatchString(result.Name) || len(result.Name) > 63 ||
		len(result.Services) == 0 || len(result.Services) > 12 || len(result.Volumes) > 40 {
		return result, errors.New("invalid Compose project/services")
	}
	seen := make(map[string]bool)
	for name, service := range result.Services {
		if !namePattern.MatchString(name) || !imagePattern.MatchString(service.Image) ||
			strings.Contains(service.Image, "..") ||
			strings.HasSuffix(service.Image, ":latest") || strings.HasSuffix(service.Image, "/latest") ||
			(!strings.Contains(service.Image, ":") && !strings.Contains(service.Image, "@sha256:")) ||
			service.Restart != "unless-stopped" || len(service.Ports) > 20 ||
			len(service.Environment) > 40 || len(service.Volumes) > 15 {
			return result, errors.New("Compose service violates allowlist")
		}
		for _, port := range service.Ports {
			if !portPattern.MatchString(port) {
				return result, errors.New("invalid localhost-only port mapping")
			}
			var host, container int
			var protocol string
			if _, err := fmt.Sscanf(port, "127.0.0.1:%d:%d/%s", &host, &container, &protocol); err != nil ||
				host < 1 || host > 65535 || container < 1 || container > 65535 ||
				(protocol != "tcp" && protocol != "udp") {
				return result, errors.New("invalid Compose port")
			}
			binding := fmt.Sprintf("%d/%s", host, protocol)
			if seen[binding] {
				return result, errors.New("duplicate host port")
			}
			seen[binding] = true
		}
		for key, value := range service.Environment {
			if !envPattern.MatchString(key) || len(value) > 512 ||
				strings.ContainsAny(value, "\n\r\x00") {
				return result, errors.New("unsafe environment value")
			}
		}
		for _, mount := range service.Volumes {
			name, target, ok := strings.Cut(mount, ":")
			if !ok || !namePattern.MatchString(name) || !strings.HasPrefix(target, "/") ||
				strings.Contains(target, "..") || strings.Contains(target, "//") ||
				strings.Contains(target, ":") || strings.ContainsAny(target, "\\ \n\r\t") ||
				len(target) > 250 {
				return result, errors.New("unsafe Compose volume mount")
			}
			if _, exists := result.Volumes[name]; !exists {
				return result, errors.New("undeclared named volume")
			}
		}
	}
	for name := range result.Volumes {
		if !namePattern.MatchString(name) {
			return result, errors.New("invalid volume name")
		}
	}
	return result, nil
}

// Executor uses only a pre-provisioned Agent-local private root (0700). Each
// project has its own stable directory and 0600 compose.json. Command args are
// fixed; no shell, arbitrary CLI flags or caller-supplied executable path.
type Executor struct {
	Root string
}

// Execute claims the task on a durable, fsync'd ledger before side effects.
// Flock serializes the entire operation between Agent processes too.
// A crash, timeout or failed command leaves the claim, and must be reconciled
// before any explicit NEW task; replay of the same task never runs Compose.
func (e Executor) Execute(ctx context.Context, taskID string, raw []byte) (int, error) {
	code, err := e.executeClaimed(ctx, taskID, raw)
	// A missing or unverified CLI exit status is UNKNOWN: never invent failure.
	// The durable claim still prevents replay after a crash or disconnection.
	if code < 0 {
		return code, err
	}
	if persistErr := e.persistResult(taskID, code); persistErr != nil {
		return -1, errors.New("Compose exit result was not durably recorded; task requires reconciliation")
	}
	return code, err
}

func (e Executor) executeClaimed(ctx context.Context, taskID string, raw []byte) (int, error) {
	if !uuidPattern.MatchString(taskID) {
		return -1, errors.New("invalid deployment task ID")
	}
	spec, err := StrictManifest(raw)
	if err != nil {
		return -1, err
	}
	root := filepath.Clean(e.Root)
	if !filepath.IsAbs(root) || root == "/" || filepath.Clean(e.Root) != e.Root || strings.Contains(root, "..") {
		return -1, errors.New("deployment root must be an absolute private directory")
	}
	if err := os.Mkdir(root, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return -1, errors.New("cannot create private deployment root")
	}
	if err := verifyPrivateDir(root); err != nil {
		return -1, err
	}
	lockFile, err := openPrivateNoFollow(filepath.Join(root, ".deploy.lock"), syscall.O_CREAT|syscall.O_RDWR)
	if err != nil {
		return -1, errors.New("deployment lock unavailable or unsafe")
	}
	defer lockFile.Close()
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX); err != nil {
		return -1, errors.New("cannot acquire deployment lock")
	}
	defer syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
	ledgerPath := filepath.Join(root, ".claims.jsonl")
	var existing []byte
	ledgerRead, err := openPrivateNoFollow(ledgerPath, syscall.O_RDONLY)
	if err == nil {
		existing, err = io.ReadAll(io.LimitReader(ledgerRead, 2*1024*1024+1))
		ledgerRead.Close()
		if err != nil {
			return -1, errors.New("cannot read claim ledger")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return -1, errors.New("unsafe claim ledger")
	}
	if len(existing) > 2*1024*1024 {
		return -1, errors.New("claim ledger capacity exceeded")
	}
	digest := sha256.Sum256(raw)
	records := bytes.Split(bytes.TrimSpace(existing), []byte("\n"))
	if len(records) > 10000 {
		return -1, errors.New("claim ledger capacity exceeded")
	}
	for _, line := range records {
		if len(line) == 0 {
			continue
		}
		var entry claim
		if json.Unmarshal(line, &entry) != nil || !uuidPattern.MatchString(entry.TaskID) ||
			!projectPattern.MatchString(entry.Project) || len(entry.Digest) != 64 {
			return -1, errors.New("claim ledger corrupted")
		}
		if entry.TaskID == taskID {
			return -1, ErrAlreadyClaimed
		}
		if entry.Project == spec.Name {
			return -1, ErrProjectUsed
		}
	}
	directory := filepath.Join(root, spec.Name)
	if err := os.Mkdir(directory, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return -1, errors.New("cannot create private Compose directory")
	}
	if err := verifyPrivateDir(directory); err != nil {
		return -1, err
	}
	manifestFile := filepath.Join(directory, "compose.json")
	// Refuse any prior manifest; a second task may not commandeer old resources.
	fd, err := os.OpenFile(manifestFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return -1, errors.New("Compose manifest file already exists or cannot be created")
	}
	if _, err := fd.Write(raw); err != nil {
		fd.Close()
		return -1, errors.New("failed to persist Compose manifest")
	}
	if err := fd.Sync(); err != nil {
		fd.Close()
		return -1, errors.New("failed to sync Compose manifest")
	}
	if err := fd.Close(); err != nil {
		return -1, errors.New("failed to close Compose manifest")
	}
	if err := syncDir(directory); err != nil {
		return -1, err
	}
	file, err := openPrivateNoFollow(ledgerPath, syscall.O_CREAT|syscall.O_APPEND|syscall.O_WRONLY)
	if err != nil {
		return -1, errors.New("cannot open private deployment ledger")
	}
	line, _ := json.Marshal(claim{TaskID: taskID, Project: spec.Name, Digest: hex.EncodeToString(digest[:])})
	if _, err := file.Write(append(line, '\n')); err != nil {
		file.Close()
		return -1, errors.New("cannot write deployment claim")
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return -1, errors.New("cannot sync deployment claim")
	}
	if err := file.Close(); err != nil {
		return -1, errors.New("cannot close deployment claim")
	}
	if err := syncDir(root); err != nil {
		return -1, err
	}
	runCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "docker", "compose", "-p", spec.Name, "-f", manifestFile, "up", "-d")
	cmd.Dir = directory
	// Compose output may contain secrets; task logs need explicit redaction.
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	err = cmd.Run()
	if err == nil {
		return 0, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), errors.New("Docker Compose returned nonzero exit code")
	}
	return -1, errors.New("Docker Compose invocation unavailable")
}

// O_NOFOLLOW prevents a symlink inside a private Agent directory from ever
// redirecting a lock, journal or secret-bearing file to another location.
func openPrivateNoFollow(path string, flags int) (*os.File, error) {
	fd, err := syscall.Open(path, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if err := verifyPrivateFile(file); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func verifyPrivateDir(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return errors.New("deployment directory must be private (0700), not a symlink")
	}
	return nil
}
func verifyPrivateFile(file *os.File) error {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("deployment ledger/lock must be private (0600)")
	}
	return nil
}
func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return errors.New("deployment directory unavailable")
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return errors.New("cannot sync deployment directory")
	}
	return nil
}
