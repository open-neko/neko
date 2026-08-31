package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/open-neko/neko/apps/openneko/internal/compose"
	"github.com/open-neko/neko/apps/openneko/internal/config"
	"github.com/open-neko/neko/apps/openneko/internal/installation"
	"github.com/open-neko/neko/apps/openneko/internal/instance"
)

type setupHostOptions struct {
	webPort             int
	webPortChanged      bool
	openShellPort       int
	openShellChanged    bool
	webBindAddress      string
	webBindChanged      bool
	dockerSubnet        string
	dockerSubnetChanged bool
}

// activateInstallation runs before every host-side command. It selects the
// per-instance config directory, then restores persisted ports and network
// settings. Named assignments are authoritative; the legacy unnamed install
// continues to honor explicit environment overrides.
func activateInstallation(selected string) error {
	if os.Getenv("OPENNEKO_PROXIED") == "1" {
		// The target worker container is already isolated by its Compose project
		// and mounts its instance config at /config/openneko directly.
		return nil
	}
	if strings.TrimSpace(selected) == "" {
		selected = os.Getenv(instance.EnvName)
	}
	if err := instance.Select(selected); err != nil {
		return err
	}
	settings, ok, err := installation.Load(config.Dir(""))
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	if settings.Instance != instance.Current() {
		return fmt.Errorf("installation settings belong to instance %q, not %q", settings.Instance, instance.Current())
	}
	// Named installations treat the persisted listener/network assignment as
	// authoritative. Otherwise a service-account environment left over from a
	// different customer can silently remap this stack during start or upgrade.
	// The legacy unnamed install retains its historical environment overrides.
	named := instance.Current() != ""
	if err := installation.ApplyEnvironment(settings, named); err != nil {
		return err
	}
	if named {
		// These values are deterministic children of DockerSubnet. Clear legacy
		// process-wide values so configureOpenShellNetwork derives this
		// customer's gateway addresses from its persisted subnet.
		for _, key := range []string{openShellNetworkGatewayEnv, openShellNetworkIPRangeEnv, openShellGatewayIPEnv} {
			if err := os.Unsetenv(key); err != nil {
				return err
			}
		}
	}
	return nil
}

func loadCurrentInstallation() (installation.Settings, bool, error) {
	return installation.Load(config.Dir(""))
}

func requireConfiguredNamedInstallation() (installation.Settings, bool, error) {
	settings, ok, err := loadCurrentInstallation()
	if err != nil || !ok || instance.Current() == "" {
		return settings, ok, err
	}
	if settings.Instance != instance.Current() {
		return installation.Settings{}, false, fmt.Errorf("installation settings belong to instance %q, not %q", settings.Instance, instance.Current())
	}
	return settings, true, nil
}

// prepareSetupInstallation resolves flag > environment > persisted setting >
// default, persists the result, and applies it before preflight or Compose run.
func prepareSetupInstallation(ctx context.Context, cmd *cobra.Command, requestedMode string, opts setupHostOptions) (installation.Settings, error) {
	existing, exists, err := loadCurrentInstallation()
	if err != nil {
		return installation.Settings{}, err
	}
	name := instance.Current()
	mode := strings.TrimSpace(requestedMode)
	if exists {
		if existing.Instance != name {
			return installation.Settings{}, fmt.Errorf("installation settings belong to instance %q, not %q", existing.Instance, name)
		}
		if !cmd.Flags().Changed("mode") {
			mode = existing.Mode
		} else if name != "" && mode != existing.Mode {
			return installation.Settings{}, fmt.Errorf("instance %q is installed in %s mode; use another instance name instead of changing it to %s", name, existing.Mode, mode)
		}
	}
	if mode == "" {
		mode = string(compose.ModeProd)
	}

	reservedPorts, err := installationPortReservations(name)
	if err != nil {
		return installation.Settings{}, err
	}
	excludedPorts := make(map[int]bool, len(reservedPorts)+1)
	for port := range reservedPorts {
		excludedPorts[port] = true
	}
	autoPorts := name != "" && !exists
	webPort, err := resolveInstallPort(opts.webPort, opts.webPortChanged, "OPENNEKO_PORT", existing.WebPort, 3000, autoPorts, excludedPorts)
	if err != nil {
		return installation.Settings{}, err
	}
	if owner, reserved := reservedPorts[webPort]; reserved {
		return installation.Settings{}, fmt.Errorf("web port %d is reserved by instance %s", webPort, owner)
	}
	excludedPorts[webPort] = true
	openShellPort, err := resolveInstallPort(opts.openShellPort, opts.openShellChanged, "OPENSHELL_PORT", existing.OpenShellPort, 18080, autoPorts, excludedPorts)
	if err != nil {
		return installation.Settings{}, err
	}
	if owner, reserved := reservedPorts[openShellPort]; reserved {
		return installation.Settings{}, fmt.Errorf("OpenShell port %d is reserved by instance %s", openShellPort, owner)
	}

	bindAddress := strings.TrimSpace(opts.webBindAddress)
	if !opts.webBindChanged {
		if env := strings.TrimSpace(os.Getenv("OPENNEKO_WEB_BIND_ADDRESS")); env != "" {
			bindAddress = env
		} else if exists {
			bindAddress = existing.WebBindAddress
		} else {
			bindAddress = "0.0.0.0"
		}
	}

	dockerSubnet := strings.TrimSpace(opts.dockerSubnet)
	if !opts.dockerSubnetChanged {
		if env := strings.TrimSpace(os.Getenv(openShellNetworkSubnetEnv)); env != "" {
			dockerSubnet = env
		} else if exists {
			dockerSubnet = existing.DockerSubnet
		} else if name != "" {
			dockerSubnet, err = allocateInstanceSubnet(ctx, name+"-"+mode)
			if err != nil {
				return installation.Settings{}, err
			}
		}
	}
	if dockerSubnet != "" {
		candidate, parseErr := netip.ParsePrefix(dockerSubnet)
		if parseErr == nil {
			reservations, reservationErr := installationSubnetReservations(name)
			if reservationErr != nil {
				return installation.Settings{}, reservationErr
			}
			for reserved, owner := range reservations {
				if prefixOverlapsAny(candidate.Masked(), []netip.Prefix{reserved}) {
					return installation.Settings{}, fmt.Errorf("Docker subnet %s is reserved by instance %s", dockerSubnet, owner)
				}
			}
		}
	}

	settings := installation.Settings{
		Version:        installation.CurrentVersion,
		Instance:       name,
		Mode:           mode,
		WebPort:        webPort,
		WebBindAddress: bindAddress,
		OpenShellPort:  openShellPort,
		DockerSubnet:   dockerSubnet,
	}
	if err := settings.Validate(); err != nil {
		return installation.Settings{}, err
	}
	if err := installation.Save(config.Dir(""), settings); err != nil {
		return installation.Settings{}, fmt.Errorf("persist installation settings: %w", err)
	}
	if err := installation.ApplyEnvironment(settings, true); err != nil {
		return installation.Settings{}, err
	}
	return settings, nil
}

func resolveInstallPort(flagValue int, flagChanged bool, envName string, persisted, fallback int, auto bool, excluded map[int]bool) (int, error) {
	if flagChanged {
		if flagValue < 1 || flagValue > 65535 {
			return 0, fmt.Errorf("--%s must be between 1 and 65535", portFlagName(envName))
		}
		return flagValue, nil
	}
	if raw := strings.TrimSpace(os.Getenv(envName)); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return 0, fmt.Errorf("%s must be a port between 1 and 65535", envName)
		}
		return port, nil
	}
	if persisted != 0 {
		return persisted, nil
	}
	if !auto {
		return fallback, nil
	}
	return firstAvailablePort(fallback, excluded)
}

func portFlagName(envName string) string {
	if envName == "OPENSHELL_PORT" {
		return "openshell-port"
	}
	return "port"
}

func firstAvailablePort(start int, excluded map[int]bool) (int, error) {
	for port := start; port <= 65535; port++ {
		if excluded[port] {
			continue
		}
		listener, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)))
		if err != nil {
			continue
		}
		_ = listener.Close()
		return port, nil
	}
	return 0, fmt.Errorf("no free host port found at or above %d", start)
}

func installationPortReservations(current string) (map[int]string, error) {
	entries, err := configuredInstallations()
	if err != nil {
		return nil, err
	}
	reserved := map[int]string{}
	for _, entry := range entries {
		if entry.Name == current {
			continue
		}
		label := entry.Name
		if label == "" {
			label = "(default)"
		}
		reserved[entry.Settings.WebPort] = label
		reserved[entry.Settings.OpenShellPort] = label
	}
	return reserved, nil
}

func installationSubnetReservations(current string) (map[netip.Prefix]string, error) {
	entries, err := configuredInstallations()
	if err != nil {
		return nil, err
	}
	reserved := map[netip.Prefix]string{}
	for _, entry := range entries {
		if entry.Name == current || entry.Settings.DockerSubnet == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(entry.Settings.DockerSubnet)
		if err != nil {
			continue
		}
		label := entry.Name
		if label == "" {
			label = "(default)"
		}
		reserved[prefix.Masked()] = label
	}
	return reserved, nil
}

// allocateInstanceSubnet selects a stable candidate from a large private pool,
// skipping subnets already claimed by Docker. The chosen value is persisted,
// so later commands never depend on Docker network enumeration order.
func allocateInstanceSubnet(ctx context.Context, seed string) (string, error) {
	occupied, err := listDockerNetworkSubnets(ctx)
	if err != nil {
		return "", fmt.Errorf("inspect Docker networks for instance allocation: %w", err)
	}
	entries, err := configuredInstallations()
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if entry.Settings.DockerSubnet == "" {
			continue
		}
		if prefix, parseErr := netip.ParsePrefix(entry.Settings.DockerSubnet); parseErr == nil {
			occupied = append(occupied, prefix.Masked())
		}
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(seed))
	const candidates = 8192 // 10.224.0.0/11 split into /24 networks.
	start := int(h.Sum32() % candidates)
	for offset := 0; offset < candidates; offset++ {
		index := (start + offset) % candidates
		candidate, _ := netip.ParsePrefix(fmt.Sprintf("10.%d.%d.0/24", 224+index/256, index%256))
		if !prefixOverlapsAny(candidate, occupied) {
			return candidate.String(), nil
		}
	}
	return "", fmt.Errorf("no unused OpenNeko Docker /24 found; pass --docker-subnet with an available private subnet")
}

var listDockerNetworkSubnets = dockerNetworkSubnets

func prefixOverlapsAny(candidate netip.Prefix, occupied []netip.Prefix) bool {
	for _, prefix := range occupied {
		if candidate.Contains(prefix.Masked().Addr()) || prefix.Contains(candidate.Masked().Addr()) {
			return true
		}
	}
	return false
}

func dockerNetworkSubnets(ctx context.Context) ([]netip.Prefix, error) {
	idsRaw, err := exec.CommandContext(ctx, "docker", "network", "ls", "-q").Output()
	if err != nil {
		return nil, err
	}
	ids := strings.Fields(string(idsRaw))
	if len(ids) == 0 {
		return nil, nil
	}
	args := append([]string{"network", "inspect"}, ids...)
	raw, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return nil, err
	}
	var networks []struct {
		IPAM struct {
			Config []struct {
				Subnet string `json:"Subnet"`
			} `json:"Config"`
		} `json:"IPAM"`
	}
	if err := json.Unmarshal(raw, &networks); err != nil {
		return nil, err
	}
	var prefixes []netip.Prefix
	for _, network := range networks {
		for _, cfg := range network.IPAM.Config {
			if prefix, err := netip.ParsePrefix(cfg.Subnet); err == nil && prefix.Addr().Is4() {
				prefixes = append(prefixes, prefix.Masked())
			}
		}
	}
	return prefixes, nil
}

func modeForStart(cmd *cobra.Command, requested string) (compose.Mode, error) {
	settings, ok, err := loadCurrentInstallation()
	if err != nil {
		return "", err
	}
	if instance.Current() != "" && !ok {
		return "", fmt.Errorf("instance %q has not been configured; run `openneko setup --instance %s` first", instance.Current(), instance.Current())
	}
	if ok && !cmd.Flags().Changed("mode") {
		requested = settings.Mode
	}
	mode := compose.Mode(requested)
	switch mode {
	case compose.ModeProd, compose.ModeDev, compose.ModeDemo:
	default:
		return "", fmt.Errorf("--mode must be one of: prod, dev, demo (got %q)", requested)
	}
	if ok && instance.Current() != "" && settings.Mode != string(mode) {
		return "", fmt.Errorf("instance %q is installed in %s mode, not %s", instance.Current(), settings.Mode, mode)
	}
	return mode, nil
}
