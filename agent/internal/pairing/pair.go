package pairing

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
)

var (
	secretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	uuidPattern   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

type Identity struct {
	AgentID    string `json:"agent_id"`
	Credential string `json:"credential"`
}

func ReadToken(reader io.Reader) (string, error) {
	data, err := bufio.NewReader(io.LimitReader(reader, 256)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", errors.New("failed to read token")
	}
	token := strings.TrimSpace(data)
	if !secretPattern.MatchString(token) {
		return "", errors.New("invalid pairing token format")
	}
	return token, nil
}

func Pair(ctx context.Context, cfg config.Config, token, version string) (Identity, error) {
	if err := cfg.Validate(); err != nil {
		return Identity{}, err
	}
	if !secretPattern.MatchString(token) {
		return Identity{}, errors.New("invalid pairing token format")
	}
	target, _ := url.Parse(cfg.ServerURL)
	if target.Scheme == "wss" {
		target.Scheme = "https"
	} else {
		target.Scheme = "http"
	}
	target.Path = "/api/v1/agent/pair"
	target.RawPath = ""
	payload, err := json.Marshal(map[string]string{
		"token": token, "name": cfg.AgentName, "version": version,
		"platform": runtime.GOOS, "architecture": runtime.GOARCH,
	})
	if err != nil {
		return Identity{}, errors.New("could not encode pairing request")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(payload))
	if err != nil {
		return Identity{}, errors.New("could not create pairing request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Navloom-CSRF", "1")
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := client.Do(req)
	if err != nil {
		// Never include URL with secrets (there are no query credentials).
		return Identity{}, fmt.Errorf("pairing request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return Identity{}, fmt.Errorf("pairing rejected (HTTP %d)", resp.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 4096))
	decoder.DisallowUnknownFields()
	var result struct {
		AgentID    string `json:"agentId"`
		Credential string `json:"credential"`
	}
	if err := decoder.Decode(&result); err != nil {
		return Identity{}, errors.New("invalid pairing response")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return Identity{}, errors.New("invalid pairing response")
	}
	if !uuidPattern.MatchString(result.AgentID) || !secretPattern.MatchString(result.Credential) {
		return Identity{}, errors.New("invalid pairing response identity")
	}
	return Identity{AgentID: result.AgentID, Credential: result.Credential}, nil
}

func EnsureUnpaired(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("identity path is required")
	}
	_, err := os.Lstat(path)
	if err == nil {
		return errors.New("identity already exists; refusing to overwrite")
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("cannot inspect identity path: %w", err)
	}
	return nil
}

func SaveIdentity(path string, identity Identity) error {
	if !uuidPattern.MatchString(identity.AgentID) || !secretPattern.MatchString(identity.Credential) {
		return errors.New("invalid Agent identity")
	}
	if err := EnsureUnpaired(path); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create identity directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("create identity file: %w", err)
	}
	complete := false
	defer func() {
		file.Close()
		if !complete {
			os.Remove(path)
		}
	}()
	if err := json.NewEncoder(file).Encode(identity); err != nil {
		return fmt.Errorf("write identity: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync identity: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close identity: %w", err)
	}
	complete = true
	return nil
}

func LoadIdentity(path string) (Identity, error) {
	var identity Identity
	stat, err := os.Lstat(path)
	if err != nil {
		return identity, fmt.Errorf("inspect identity: %w", err)
	}
	if !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 {
		return identity, errors.New("identity must be a regular file with private permissions (0600)")
	}
	file, err := os.Open(path)
	if err != nil {
		return identity, fmt.Errorf("open identity: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&identity); err != nil {
		return Identity{}, errors.New("invalid identity file")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return Identity{}, errors.New("invalid identity file")
	}
	if !uuidPattern.MatchString(identity.AgentID) || !secretPattern.MatchString(identity.Credential) {
		return Identity{}, errors.New("invalid identity file")
	}
	return identity, nil
}
