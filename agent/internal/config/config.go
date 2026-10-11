package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	ServerURL        string `json:"server_url"`
	AgentName        string `json:"agent_name"`
	TokenFile        string `json:"token_file"`
	EndpointHost     string `json:"endpoint_host"`
	EndpointPort     int    `json:"endpoint_port"`
	TLSCertFile      string `json:"tls_cert_file"`
	TLSKeyFile       string `json:"tls_key_file"`
	AllowInsecureDev bool   `json:"allow_insecure_dev"`
}

func Load(path string) (Config, error) {
	cfg := Config{AgentName: "navloom-agent"}
	if path != "" {
		file, err := os.Open(path)
		if err != nil {
			return cfg, fmt.Errorf("open Agent config: %w", err)
		}
		defer file.Close()

		decoder := json.NewDecoder(file)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&cfg); err != nil {
			return cfg, fmt.Errorf("parse Agent config: %w", err)
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			return cfg, errors.New("Agent config must contain exactly one JSON object")
		}
	}

	if value := os.Getenv("NAVLOOM_SERVER_URL"); value != "" {
		cfg.ServerURL = value
	}
	if value := os.Getenv("NAVLOOM_AGENT_NAME"); value != "" {
		cfg.AgentName = value
	}
	if value := os.Getenv("NAVLOOM_AGENT_TOKEN_FILE"); value != "" {
		cfg.TokenFile = value
	}
	if value := os.Getenv("NAVLOOM_ALLOW_INSECURE_DEV"); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			return cfg, errors.New("NAVLOOM_ALLOW_INSECURE_DEV must be a boolean")
		}
		cfg.AllowInsecureDev = parsed
	}

	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.AgentName) == "" {
		return errors.New("Agent name must not be empty")
	}
	if c.ReverseEndpointConfigured() {
		if net.ParseIP(c.EndpointHost) == nil || c.EndpointPort < 1 || c.EndpointPort > 65535 ||
			c.TLSCertFile == "" || c.TLSKeyFile == "" {
			return errors.New("reverse WSS endpoint requires IP, port, TLS certificate and private key")
		}
		ip := net.ParseIP(c.EndpointHost)
		if !ip.IsPrivate() && !carrierGradeNAT(ip) {
			return errors.New("reverse WSS endpoint must be a private/EasyTier IP")
		}
	}
	if strings.TrimSpace(c.ServerURL) == "" {
		return errors.New("NAVLOOM_SERVER_URL (or server_url in config) is required")
	}
	target, err := url.Parse(c.ServerURL)
	if err != nil || target.Host == "" {
		return errors.New("invalid Agent Server URL")
	}
	if target.User != nil || target.Fragment != "" || target.RawQuery != "" {
		return errors.New("Server URL must not contain credentials, query parameters, or fragments")
	}
	if target.Scheme == "wss" {
		return nil
	}
	if target.Scheme == "ws" && c.AllowInsecureDev && isLoopback(target.Hostname()) {
		return nil
	}
	return errors.New("Agent Server URL must use wss:// (ws:// is allowed only for explicit loopback development)")
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// carrierGradeNAT permits EasyTier overlays using RFC 6598 addresses.
func carrierGradeNAT(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
}

// ReverseEndpointConfigured means the Agent is configured to listen for Server WSS.
func (c Config) ReverseEndpointConfigured() bool {
	return c.EndpointHost != "" || c.EndpointPort != 0 || c.TLSCertFile != "" || c.TLSKeyFile != ""
}
