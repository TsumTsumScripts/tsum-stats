// tsum-stats serves the Tsum Tsum stats site: PocketBase, plus a listener for
// the app's script events and an importer for the script's CSV files.
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"os"
	"time"

	"github.com/TsumTsumScripts/tsum-stats/internal/stats"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/spf13/cobra"
)

//go:embed all:web
var webFS embed.FS

// The address `serve` listens on by default, which a launch opens.
const siteURL = "http://127.0.0.1:8090"

// Set by tools/build.sh from VERSION.
var version = "dev"

func main() {
	// Double-clicked or started with no command: update if a newer one is out,
	// then serve and open the site.
	launched := len(os.Args) == 1
	if launched {
		if alreadyRunning(siteURL) {
			fmt.Println("Tsum Tsum Stats is already running; opening it:", siteURL)
			openBrowser(siteURL)
			return
		}
		clearOld()
		if os.Getenv("TSUM_STATS_NO_UPDATE") == "" && updateURL != "" {
			if done, err := selfUpdate(updateURL, log.Printf); err != nil {
				log.Printf("update check skipped: %v", err)
			} else if done {
				restart()
			}
		}
		os.Args = append(os.Args, "serve")
	}

	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: dataDir()})
	app.RootCmd.Use = "tsum-stats"
	app.RootCmd.Version = version
	cfg := &stats.Config{Version: version}
	flags := app.RootCmd.PersistentFlags()
	flags.StringVar(&cfg.EventsAddr, "events-addr", "127.0.0.1:21025",
		"listen here for devices dialling in with script events (\"\" disables); the emulator reaches 127.0.0.1 as 10.0.2.2")
	flags.StringArrayVar(&cfg.EventsConnect, "events-connect", nil,
		"also dial a device's event listener at HOST:PORT, e.g. through adb forward (repeatable)")
	flags.StringVar(&cfg.EventsToken, "events-token", "", "refuse devices whose hello does not carry this token")
	flags.StringArrayVar(&cfg.ImportDirs, "import-dir", nil,
		"scan this folder for stats_*.csv and tsum_list_*.csv (repeatable)")
	flags.DurationVar(&cfg.ScanInterval, "scan-interval", 10*time.Second, "how often the import folders are rescanned")
	flags.StringVar(&cfg.ADB, "adb", "", "adb used to import stats files from devices (default: adb on PATH or in the Android SDK)")
	flags.StringVar(&cfg.DeviceStorage, "device-storage", stats.DefaultDeviceStorage, "the automation app's storage folder on the device")
	flags.StringVar(&cfg.WebDir, "web-dir", "",
		"serve files in this folder in place of the built-in site's; created with a README when missing")

	embedded, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	app.RootCmd.AddCommand(updateCmd())
	app.RootCmd.AddCommand(webCmd(embedded))
	app.RootCmd.AddCommand(snapshotCmd(app, embedded))

	stats.Register(app, cfg, embedded)
	if launched {
		app.OnServe().BindFunc(func(se *core.ServeEvent) error {
			go openWhenUp(siteURL)
			return se.Next()
		})
	}

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

// webCmd is `tsum-stats web export DIR`: a copy of the built-in site to edit.
func webCmd(embedded fs.FS) *cobra.Command {
	var force bool
	export := &cobra.Command{
		Use:   "export DIR",
		Short: "Copy the built-in site into DIR, with an override.json for this version, to edit and serve with --web-dir",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			written, kept, err := stats.ExportSite(embedded, args[0], version, force)
			if err != nil {
				return err
			}
			fmt.Printf("%d files written to %s", written, args[0])
			if kept > 0 {
				fmt.Printf(", %d existing files kept (--force replaces them)", kept)
			}
			fmt.Println()
			return nil
		},
	}
	export.Flags().BoolVar(&force, "force", false, "replace files that already exist")
	web := &cobra.Command{Use: "web", Short: "The stats site's files"}
	web.AddCommand(export)
	return web
}

// snapshotCmd is `tsum-stats snapshot DIR`: the site and its data as plain
// files, for a host that only serves files.
func snapshotCmd(app *pocketbase.PocketBase, embedded fs.FS) *cobra.Command {
	var opts stats.SnapshotOptions
	cmd := &cobra.Command{
		Use:   "snapshot DIR",
		Short: "Write the site and its data as static files into DIR, to publish on a file host such as GitHub Pages",
		Long: "Writes the built-in site plus the stored rounds (one file per month) and Tsum lists into DIR.\n" +
			"Files that did not change are left alone, so the folder can be a git checkout that is updated in place.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			opts.Version = version
			res, err := stats.ExportSnapshot(app.DB(), embedded, args[0], opts)
			if err != nil {
				return err
			}
			fmt.Printf("%d rounds in %d months; %d files written to %s\n", res.Rounds, res.Months, res.Files, args[0])
			return nil
		},
	}
	cmd.Flags().StringVar(&opts.Devices, "devices", stats.DevicesAnonymous,
		"how device names appear: anonymous (Device 1, Device 2), keep, or hide")
	cmd.Flags().BoolVar(&opts.NoOwned, "no-collection", false, "leave out the Tsum lists (which Tsums the player owns)")
	return cmd
}

// updateCmd is `tsum-stats update`: fetch the newest version now.
func updateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "update",
		Short: "Replace this program with the newest version, checked against its published sha256",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if updateURL == "" {
				return fmt.Errorf("this build has no update address")
			}
			done, err := selfUpdate(updateURL, log.Printf)
			if err != nil {
				return err
			}
			if done {
				fmt.Println("Updated. Start tsum-stats again to use the new version.")
			} else {
				fmt.Printf("tsum-stats %s is the newest version.\n", version)
			}
			return nil
		},
	}
}
