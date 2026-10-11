package pairing

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
)

func TestGenerateAgentTLSPrivateAndPinnedIP(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{
		ServerURL: "wss://navloom.example.com/agent", AgentName: "nas",
		EndpointHost: "10.10.20.30", EndpointPort: 9443,
		TLSCertFile: filepath.Join(dir, "agent.pem"), TLSKeyFile: filepath.Join(dir, "agent.key"),
	}
	if err := GenerateAgentTLS(cfg); err != nil { t.Fatal(err) }
	keyInfo, err := os.Stat(cfg.TLSKeyFile)
	if err != nil || keyInfo.Mode().Perm() != 0600 { t.Fatalf("key permissions: %v, %v", keyInfo, err) }
	if _, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile); err != nil { t.Fatal(err) }
	certData, err := os.ReadFile(cfg.TLSCertFile)
	if err != nil { t.Fatal(err) }
	block, _ := pem.Decode(certData)
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil { t.Fatal(err) }
	if len(cert.IPAddresses) != 1 || cert.IPAddresses[0].String() != cfg.EndpointHost { t.Fatal("wrong IP SAN") }
	if !certificateValidFor(cert, x509.ExtKeyUsageServerAuth) { t.Fatal("wrong certificate purpose") }
	if err := GenerateAgentTLS(cfg); err == nil { t.Fatal("must not overwrite existing TLS identity") }
	cfg.EndpointHost = "8.8.8.8"
	if err := GenerateAgentTLS(cfg); err == nil { t.Fatal("public IP must be rejected") }
}
