package pairing

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
)

var (
	secretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	uuidPattern   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

type Identity struct {
	AgentID                    string `json:"agent_id"`
	Credential                 string `json:"credential"`
	ServerClientCertificatePEM string `json:"server_client_certificate_pem,omitempty"`
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
	requestBody := map[string]any{
		"token": token, "name": cfg.AgentName, "version": version,
		"platform": runtime.GOOS, "architecture": runtime.GOARCH,
	}
	if cfg.EndpointHost != "" {
		certificate, err := os.ReadFile(cfg.TLSCertFile)
		if err != nil || len(certificate) > 8192 {
			return Identity{}, errors.New("cannot read Agent TLS certificate")
		}
		block, rest := pem.Decode(certificate)
		if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
			return Identity{}, errors.New("Agent TLS certificate must contain one PEM certificate")
		}
		if _, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile); err != nil {
			return Identity{}, errors.New("Agent TLS certificate and key do not match")
		}
		parsed, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return Identity{}, errors.New("invalid Agent TLS certificate")
		}
		endpointIP := net.ParseIP(cfg.EndpointHost)
		matched := false
		for _, ip := range parsed.IPAddresses {
			if ip.Equal(endpointIP) {
				matched = true
			}
		}
		if !matched {
			return Identity{}, errors.New("Agent TLS certificate IP SAN does not match endpoint")
		}
		if parsed.IsCA || !certificateValidFor(parsed, x509.ExtKeyUsageServerAuth) {
			return Identity{}, errors.New("Agent TLS certificate must be a valid server certificate")
		}
		keyInfo, err := os.Stat(cfg.TLSKeyFile)
		if err != nil || !keyInfo.Mode().IsRegular() || keyInfo.Mode().Perm()&0077 != 0 {
			return Identity{}, errors.New("Agent TLS key must be a private file")
		}
		requestBody["endpoint"] = map[string]any{
			"host": cfg.EndpointHost, "port": cfg.EndpointPort, "certificatePem": string(certificate),
		}
	}
	payload, err := json.Marshal(requestBody)
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
		AgentID                    string `json:"agentId"`
		Credential                 string `json:"credential"`
		ServerClientCertificatePEM string `json:"serverClientCertificatePem,omitempty"`
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
	if cfg.EndpointHost != "" {
		cert, err := parseSingleCertificate(result.ServerClientCertificatePEM)
		if err != nil || cert.IsCA || !certificateValidFor(cert, x509.ExtKeyUsageClientAuth) {
			return Identity{}, errors.New("invalid Server client certificate in pairing response")
		}
	}
	return Identity{AgentID: result.AgentID, Credential: result.Credential,
		ServerClientCertificatePEM: result.ServerClientCertificatePEM}, nil
}

func parseSingleCertificate(raw string) (*x509.Certificate, error) {
	block, rest := pem.Decode([]byte(raw))
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("expected one PEM certificate")
	}
	return x509.ParseCertificate(block.Bytes)
}

func certificateValidFor(cert *x509.Certificate, purpose x509.ExtKeyUsage) bool {
	now := time.Now()
	if now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) {
		return false
	}
	for _, usage := range cert.ExtKeyUsage {
		if usage == purpose || usage == x509.ExtKeyUsageAny {
			return true
		}
	}
	return false
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
	if identity.ServerClientCertificatePEM != "" {
		cert, err := parseSingleCertificate(identity.ServerClientCertificatePEM)
		if err != nil || cert.IsCA || !certificateValidFor(cert, x509.ExtKeyUsageClientAuth) {
			return errors.New("invalid pinned Server client certificate")
		}
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
	if identity.ServerClientCertificatePEM != "" {
		cert, err := parseSingleCertificate(identity.ServerClientCertificatePEM)
		if err != nil || cert.IsCA || !certificateValidFor(cert, x509.ExtKeyUsageClientAuth) {
			return Identity{}, errors.New("invalid pinned Server client certificate")
		}
	}
	return identity, nil
}
