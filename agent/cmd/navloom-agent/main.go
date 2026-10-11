package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/CiBeDerORG/Navloom/agent/internal/config"
	"github.com/CiBeDerORG/Navloom/agent/internal/pairing"
	"github.com/CiBeDerORG/Navloom/agent/internal/probe"
	"github.com/CiBeDerORG/Navloom/agent/internal/transport"
)

var version = "0.2.0-m2"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	flags := flag.NewFlagSet("navloom-agent", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	configPath := flags.String("config", "", "optional path to Agent JSON config")
	showVersion := flags.Bool("version", false, "print Agent version")
	check := flags.Bool("check", false, "check TCP/TLS reachability and exit (not WSS handshake)")
	pair := flags.Bool("pair", false, "pair using a one-time token read from stdin and save the Agent identity")
	initTLS := flags.Bool("init-tls", false, "generate a private Agent TLS certificate and key for the configured IP")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if (*pair && *check) || (*initTLS && (*pair || *check)) {
		fmt.Fprintln(os.Stderr, "-init-tls, -pair and -check cannot be combined")
		return 2
	}
	if *showVersion {
		fmt.Println("Navloom Agent " + version)
		return 0
	}

	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Error("invalid Agent configuration", "error", err)
		return 2
	}

	if *initTLS {
		if err := pairing.GenerateAgentTLS(cfg); err != nil {
			log.Error("cannot initialize Agent TLS identity", "error", err)
			return 1
		}
		log.Info("Agent TLS certificate and private key generated")
		return 0
	}
	if *check {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		if err := probe.Check(ctx, cfg); err != nil {
			log.Error("Server reachability check failed", "error", err)
			return 1
		}
		log.Info("Server TCP/TLS reachable; normal startup performs WSS handshake")
		return 0
	}

	if *pair {
		if cfg.TokenFile == "" {
			log.Error("pairing requires token_file or NAVLOOM_AGENT_TOKEN_FILE")
			return 2
		}
		if err := pairing.EnsureUnpaired(cfg.TokenFile); err != nil {
			log.Error("cannot pair this Agent", "error", err)
			return 1
		}
		fmt.Fprintln(os.Stderr, "Provide the one-time token on stdin (use shell read -s to prevent terminal echo):")
		token, err := pairing.ReadToken(os.Stdin)
		if err != nil {
			log.Error("cannot read pairing token", "error", err)
			return 1
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		identity, err := pairing.Pair(ctx, cfg, token, version)
		if err != nil {
			log.Error("Agent pairing failed", "error", err)
			return 1
		}
		if err := pairing.SaveIdentity(cfg.TokenFile, identity); err != nil {
			log.Error("Agent paired but identity could not be saved; issue a new token after fixing storage", "error", err)
			return 1
		}
		log.Info("Agent paired; identity saved", "agent_id", identity.AgentID)
		return 0
	}

	if cfg.TokenFile == "" {
		log.Error("normal Agent startup requires token_file or NAVLOOM_AGENT_TOKEN_FILE")
		return 2
	}
	identity, err := pairing.LoadIdentity(cfg.TokenFile)
	if err != nil {
		log.Error("cannot load private Agent identity", "error", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var transportError error
	if cfg.ReverseEndpointConfigured() {
		transportError = transport.RunPassive(ctx, cfg, identity, version, log)
	} else {
		// Temporary legacy fallback while T-037/T-040 replace Server's inbound WSS.
		transportError = transport.Run(ctx, cfg, identity, version, log)
	}
	if transportError != nil {
		log.Error("Agent transport stopped", "error", transportError)
		return 1
	}
	log.Info("Agent stopped")
	return 0
}
