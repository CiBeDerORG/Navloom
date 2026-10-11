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
	if err := flags.Parse(args); err != nil {
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

	log.Warn("M0 Agent scaffold only: WSS pairing, heartbeats and Docker operations are not implemented")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	log.Info("Agent stopped")
	return 0
}
