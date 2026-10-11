package pairing

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
)

// GenerateAgentTLS creates an IP SAN certificate for a passive private-network WSS listener.
// Private keys never leave the NAS. Existing keys/certificates are never overwritten.
func GenerateAgentTLS(cfg config.Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if !cfg.ReverseEndpointConfigured() {
		return errors.New("configure endpoint_host, endpoint_port, tls_cert_file and tls_key_file first")
	}
	for _, path := range []string{cfg.TLSCertFile, cfg.TLSKeyFile} {
		if _, err := os.Lstat(path); err == nil {
			return fmt.Errorf("TLS file already exists; refusing overwrite: %s", filepath.Base(path))
		} else if !errors.Is(err, os.ErrNotExist) {
			return errors.New("cannot inspect TLS file path")
		}
	}
	ip := net.ParseIP(cfg.EndpointHost)
	if ip == nil {
		return errors.New("invalid Agent endpoint IP")
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Navloom Agent"},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IPAddresses:           []net.IP{ip},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, privateKey.Public(), privateKey)
	if err != nil {
		return err
	}
	keyDer, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(cfg.TLSKeyFile), 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(cfg.TLSCertFile), 0700); err != nil {
		return err
	}
	keyFile, err := os.OpenFile(cfg.TLSKeyFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	keyWritten := false
	defer func() {
		keyFile.Close()
		if !keyWritten {
			os.Remove(cfg.TLSKeyFile)
		}
	}()
	if _, err := keyFile.Write(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDer})); err != nil {
		return err
	}
	if err := keyFile.Sync(); err != nil {
		return err
	}
	certFile, err := os.OpenFile(cfg.TLSCertFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	certWritten := false
	defer func() {
		certFile.Close()
		if !certWritten {
			os.Remove(cfg.TLSCertFile)
		}
	}()
	if _, err := certFile.Write(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})); err != nil {
		return err
	}
	if err := certFile.Sync(); err != nil {
		return err
	}
	if err := certFile.Close(); err != nil {
		return err
	}
	if err := keyFile.Close(); err != nil {
		return err
	}
	keyWritten, certWritten = true, true
	return nil
}
