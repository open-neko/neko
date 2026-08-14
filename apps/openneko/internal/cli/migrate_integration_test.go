//go:build integration

package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func TestMigrateSkipSchemaStillProvisionsOpenShellRole(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pg, err := postgres.Run(ctx,
		"pgvector/pgvector:pg16",
		postgres.WithDatabase("neko"),
		postgres.WithUsername("neko"),
		postgres.WithPassword("secret"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(2*time.Minute),
		),
	)
	if err != nil {
		t.Fatalf("postgres container: %v", err)
	}
	t.Cleanup(func() { _ = pg.Terminate(context.Background()) })

	host, err := pg.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := pg.MappedPort(ctx, "5432/tcp")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("NEKO_PG_HOST", host)
	t.Setenv("NEKO_PG_PORT", port.Port())
	t.Setenv("NEKO_PG_USER", "neko")
	t.Setenv("NEKO_PG_PASSWORD", "secret")
	t.Setenv("NEKO_PG_DATABASE", "neko")
	t.Setenv(openShellDBPasswordEnv, "private-container-password")

	cmd := newMigrateCmd()
	cmd.SetArgs([]string{"--skip-schema"})
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	if err := cmd.ExecuteContext(ctx); err != nil {
		t.Fatalf("migrate --skip-schema: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "schema migrations skipped") ||
		!strings.Contains(out.String(), "OpenShell database role ready") {
		t.Fatalf("unexpected output: %s", out.String())
	}

	dsn := "postgres://openshell:private-container-password@" + host + ":" +
		port.Port() + "/neko?sslmode=disable"
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect as provisioned role: %v", err)
	}
	defer conn.Close(ctx)
	var member bool
	if err := conn.QueryRow(ctx, "SELECT pg_has_role(current_user, 'neko', 'member')").Scan(&member); err != nil {
		t.Fatal(err)
	}
	if !member {
		t.Fatal("openshell role is not a member of neko")
	}
}
