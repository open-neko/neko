package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/open-neko/neko/apps/openneko/assets"
	"github.com/open-neko/neko/apps/openneko/internal/compose"
)

func newUpgradeCmd() *cobra.Command {
	var mode string
	var imageVersion string
	var noPrune bool

	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Pull newer OpenNeko images and update the current stack",
		Long: `Pull newer OpenNeko component images, recreate the current stack, and clean
up old OpenNeko image tags.

By default the command targets the latest image tag and upgrades the current
stack mode. It first uses the mode recorded by the last setup/start, then falls
back to existing Docker Compose project names for older installs. Use --version
to pin a specific image tag, and --mode if multiple OpenNeko stacks exist.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx, cancel := context.WithCancel(cmd.Context())
			defer cancel()
			return runUpgrade(ctx, cmd, upgradeOptions{
				mode:         mode,
				imageVersion: imageVersion,
				noPrune:      noPrune,
			})
		},
	}
	cmd.Flags().StringVar(&mode, "mode", "auto", "Stack mode to upgrade: auto|prod|dev|demo")
	cmd.Flags().StringVar(&imageVersion, "version", "", "OpenNeko image tag/version to install (default: latest; accepts 1.2.3 or v1.2.3)")
	cmd.Flags().BoolVar(&noPrune, "no-prune", false, "Keep old OpenNeko image tags after the upgrade")
	return cmd
}

type upgradeOptions struct {
	mode         string
	imageVersion string
	noPrune      bool
}

func runUpgrade(ctx context.Context, cmd *cobra.Command, opts upgradeOptions) error {
	out := cmd.OutOrStdout()
	errOut := cmd.ErrOrStderr()
	target := normalizeUpgradeImageVersion(opts.imageVersion)

	sup := compose.New(assets.ComposeFS)
	m, defaulted, err := resolveUpgradeMode(ctx, opts.mode, sup)
	if err != nil {
		return err
	}
	if defaulted {
		fmt.Fprintln(errOut, "warning: no saved stack mode or existing OpenNeko Docker stack found; assuming prod. Re-run with --mode dev or --mode demo if this install used another mode.")
	}

	previous, hadPrevious := os.LookupEnv("OPENNEKO_VERSION")
	if err := os.Setenv("OPENNEKO_VERSION", target); err != nil {
		return err
	}
	defer func() {
		if hadPrevious {
			_ = os.Setenv("OPENNEKO_VERSION", previous)
		} else {
			_ = os.Unsetenv("OPENNEKO_VERSION")
		}
	}()

	files, err := sup.Materialize(m)
	if err != nil {
		return err
	}
	project, err := sup.ProjectName(m)
	if err != nil {
		return err
	}

	fmt.Fprintf(out, "Upgrading OpenNeko %s stack to image tag %s\n", m, target)
	fmt.Fprintln(out, "Pulling stack images...")
	if code, err := sup.Run(ctx, project, files, []string{"pull"}, os.Stdout, os.Stderr); err != nil {
		return err
	} else if code != 0 {
		return WithExit(code, nil)
	}

	for _, image := range extraUpgradeImageRefs(target) {
		fmt.Fprintf(out, "Pulling %s...\n", image)
		if err := sup.PullImage(ctx, image, os.Stdout, os.Stderr); err != nil {
			return err
		}
	}

	fmt.Fprintln(out, "Restarting stack with upgraded images...")
	if err := restartUpgradedStack(ctx, sup, project, files); err != nil {
		return err
	}

	if err := sup.WriteImageVersion(target); err != nil {
		return err
	}

	if !opts.noPrune {
		fmt.Fprintln(out, "Cleaning up old OpenNeko images...")
		if err := pruneOldOpenNekoImages(ctx, target, os.Stdout, os.Stderr); err != nil {
			fmt.Fprintf(errOut, "warning: old image cleanup failed: %v\n", err)
		}
		if err := pruneDanglingImages(ctx, os.Stdout, os.Stderr); err != nil {
			fmt.Fprintf(errOut, "warning: dangling image cleanup failed: %v\n", err)
		}
	}

	fmt.Fprintf(out, "Upgrade complete. Future starts will use image tag %s.\n", target)
	return nil
}

func restartUpgradedStack(ctx context.Context, sup *compose.Supervisor, project string, files []string) error {
	if err := configureOpenShellStateDir(); err != nil {
		return err
	}
	configureOpenShellDBURL()
	code, err := sup.Run(ctx, project, files, []string{"up", "-d", "--pull", "never", "--remove-orphans"}, os.Stdout, os.Stderr)
	if err != nil {
		return err
	}
	if code != 0 {
		return WithExit(code, nil)
	}
	return nil
}

func resolveUpgradeMode(ctx context.Context, flag string, sup *compose.Supervisor) (compose.Mode, bool, error) {
	mode := strings.TrimSpace(flag)
	if mode != "" && mode != "auto" {
		switch compose.Mode(mode) {
		case compose.ModeProd, compose.ModeDev, compose.ModeDemo:
			return compose.Mode(mode), false, nil
		default:
			return "", false, fmt.Errorf("--mode must be one of: auto, prod, dev, demo (got %q)", flag)
		}
	}
	project, err := sup.ProjectName("")
	if err != nil {
		return "", false, err
	}
	if detected, ok := compose.ModeFromProjectName(project); ok {
		return detected, false, nil
	}
	if detected, ok, err := detectExistingOpenNekoMode(ctx); err != nil {
		return "", false, err
	} else if ok {
		return detected, false, nil
	}
	return compose.ModeProd, true, nil
}

var listDockerComposeProjectNames = dockerComposeProjectNames

func detectExistingOpenNekoMode(ctx context.Context) (compose.Mode, bool, error) {
	running, err := listDockerComposeProjectNames(ctx, false)
	if err != nil {
		return "", false, fmt.Errorf("inspect running Docker compose projects: %w", err)
	}
	if mode, ok, err := modeFromExistingProjects(running); ok || err != nil {
		return mode, ok, err
	}

	all, err := listDockerComposeProjectNames(ctx, true)
	if err != nil {
		return "", false, fmt.Errorf("inspect Docker compose projects: %w", err)
	}
	return modeFromExistingProjects(all)
}

func dockerComposeProjectNames(ctx context.Context, all bool) ([]string, error) {
	args := []string{"ps"}
	if all {
		args = append(args, "-a")
	}
	args = append(args,
		"--filter", "label=com.docker.compose.project",
		"--format", `{{.Label "com.docker.compose.project"}}`,
	)
	out, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return nil, err
	}
	return uniqueLines(string(out)), nil
}

func modeFromExistingProjects(projects []string) (compose.Mode, bool, error) {
	modes := map[compose.Mode]string{}
	for _, project := range projects {
		mode, ok := modeFromLegacyProjectName(project)
		if !ok {
			continue
		}
		modes[mode] = project
	}
	if len(modes) == 0 {
		return "", false, nil
	}
	if len(modes) == 1 {
		for mode := range modes {
			return mode, true, nil
		}
	}
	return "", false, fmt.Errorf("found multiple OpenNeko stacks (%s); re-run with --mode prod, --mode dev, or --mode demo", strings.Join(sortedProjectNames(modes), ", "))
}

func modeFromLegacyProjectName(project string) (compose.Mode, bool) {
	if project == "openneko" {
		return compose.ModeProd, true
	}
	if mode, ok := compose.ModeFromProjectName(project); ok {
		return mode, true
	}
	return "", false
}

func uniqueLines(s string) []string {
	return uniqueStrings(strings.Split(s, "\n"))
}

func sortedProjectNames(modes map[compose.Mode]string) []string {
	names := make([]string, 0, len(modes))
	for _, project := range modes {
		names = append(names, project)
	}
	sort.Strings(names)
	return names
}

var semverishImageVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+.*$`)

func normalizeUpgradeImageVersion(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "latest"
	}
	if semverishImageVersion.MatchString(v) {
		return "v" + v
	}
	return v
}

func extraUpgradeImageRefs(version string) []string {
	return uniqueStrings([]string{
		agentImageRef(os.Getenv("OPENNEKO_AGENT_IMAGE"), version),
		pluginBaseImageRef(os.Getenv("OPENNEKO_PLUGIN_BASE_IMAGE"), version),
	})
}

func pluginBaseImageRef(override, version string) string {
	if override != "" {
		return override
	}
	return "ghcr.io/open-neko/plugin-base:" + version
}

func pruneOldOpenNekoImages(ctx context.Context, targetTag string, stdout, stderr *os.File) error {
	cmd := exec.CommandContext(ctx, "docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}")
	out, err := cmd.Output()
	if err != nil {
		return err
	}
	for _, ref := range oldOpenNekoImageRefs(string(out), targetTag) {
		rm := exec.CommandContext(ctx, "docker", "image", "rm", ref)
		rm.Stdout = stdout
		rm.Stderr = stderr
		if err := rm.Run(); err != nil {
			fmt.Fprintf(stderr, "warning: kept old image %s (%v)\n", ref, err)
		}
	}
	return nil
}

func pruneDanglingImages(ctx context.Context, stdout, stderr *os.File) error {
	cmd := exec.CommandContext(ctx, "docker", "image", "prune", "-f")
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

func oldOpenNekoImageRefs(imageListOutput, targetTag string) []string {
	repos := openNekoImageRepos()
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(imageListOutput, "\n") {
		ref := strings.TrimSpace(line)
		if ref == "" || seen[ref] {
			continue
		}
		repo, tag, ok := strings.Cut(ref, ":")
		if !ok || tag == "" || tag == "<none>" {
			continue
		}
		if !repos[repo] || tag == targetTag {
			continue
		}
		seen[ref] = true
		out = append(out, ref)
	}
	return out
}

func openNekoImageRepos() map[string]bool {
	return map[string]bool{
		"ghcr.io/open-neko/neko-cli":         true,
		"ghcr.io/open-neko/neko-graphjin":    true,
		"ghcr.io/open-neko/records-graphjin": true,
		"ghcr.io/open-neko/neko-web":         true,
		"ghcr.io/open-neko/neko-worker":      true,
		"ghcr.io/open-neko/agent":            true,
		"ghcr.io/open-neko/plugin-base":      true,
	}
}

func uniqueStrings(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, s := range in {
		if s = strings.TrimSpace(s); s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
