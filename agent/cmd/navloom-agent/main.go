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
)

var version = "0.1.0-m0"

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
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *pair && *check {
		fmt.Fprintln(os.Stderr, "-pair and -check cannot be combined")
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

	if *check {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		if err := probe.Check(ctx, cfg); err != nil {
			log.Error("Server reachability check failed", "error", err)
			return 1
		}
		log.Info("Server TCP/TLS reachable; WSS handshake not implemented in M0")
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
		fmt.Fprintln(os.Stderr, "Paste the one-time pairing token via stdin (input is not echoed by Navloom):")
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
		log.Info("Agent paired; WSS connectivity is not yet implemented", "agent_id", identity.AgentID)
		return 0
	}

	log.Warn("M2 pairing is available; WSS, heartbeats and Docker operations are not implemented yet")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	log.Info("Agent stopped")
	return 0
}
