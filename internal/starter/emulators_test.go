package starter

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSerialPort(t *testing.T) {
	cases := []struct {
		serial string
		host   string
		port   int
		ok     bool
	}{
		{"127.0.0.1:16384", "127.0.0.1", 16384, true},
		{"localhost:5555", "localhost", 5555, true},
		{"emulator-5554", "127.0.0.1", 5555, true}, // console port + 1
		{"[::1]:5565", "::1", 5565, true},
		{"192.168.1.50:5555", "192.168.1.50", 5555, true},
		{"R58M12ABCDE", "", 0, false},
		{"emulator-x", "127.0.0.1", 1, false},
		{"127.0.0.1:abc", "", 0, false},
	}
	for _, c := range cases {
		host, port, ok := serialPort(c.serial)
		if ok != c.ok || ok && (host != c.host || port != c.port) {
			t.Errorf("%s: got %s %d %v", c.serial, host, port, ok)
		}
	}
}

func TestParseMuMuInfo(t *testing.T) {
	list, err := parseMuMuInfo(fixture(t, "mumu_info_all.json"))
	if err != nil {
		t.Fatal(err)
	}
	want := []EmuInstance{
		{ID: "0", Name: "MuMu Player 12", Port: 16384, Running: true},
		{ID: "1", Name: "MuMu Player 12-1", Port: 16416}, // stopped: no adb_port, so 16384 + 32i
		{ID: "2", Name: "Farm 3", Port: 16448, Running: true},
	}
	if len(list) != len(want) {
		t.Fatalf("got %+v", list)
	}
	for i := range want {
		if list[i] != want[i] {
			t.Errorf("instance %d: got %+v, want %+v", i, list[i], want[i])
		}
	}
	// One instance comes back bare, sometimes after a warning line.
	one, err := parseMuMuInfo(append([]byte("warning: something\n"), fixture(t, "mumu_info_one.json")...))
	if err != nil || len(one) != 1 || one[0].Port != 16384 || !one[0].Running {
		t.Fatalf("single: %+v %v", one, err)
	}
	if _, err := parseMuMuInfo([]byte("not json")); err == nil {
		t.Fatal("garbage should be an error")
	}
}

func TestParseLDList2(t *testing.T) {
	list := parseLDList2(string(fixture(t, "ldconsole_list2.txt")))
	want := []EmuInstance{
		{ID: "0", Name: "LDPlayer", Port: 5555, Running: true},
		{ID: "1", Name: "LDPlayer-1", Port: 5557},
		{ID: "2", Name: "Farm", Port: 5559},
	}
	if len(list) != len(want) {
		t.Fatalf("got %+v", list)
	}
	for i := range want {
		if list[i] != want[i] {
			t.Errorf("instance %d: got %+v, want %+v", i, list[i], want[i])
		}
	}
	if got := parseLDList2("error: not found\n\n"); len(got) != 0 {
		t.Fatalf("noise: %+v", got)
	}
}

func TestParseBlueStacks(t *testing.T) {
	list := parseBlueStacksConf(string(fixture(t, "bluestacks.conf")))
	got := []string{}
	for _, in := range list {
		got = append(got, in.ID+":"+strconv.Itoa(in.Port))
	}
	if strings.Join(got, " ") != "Pie64:5555 Pie64_1:5565 Rvc64:5575" {
		t.Fatalf("instances: %v", got)
	}
	procs := parseWinProcs(fixture(t, "win_procs.json"))
	if len(procs) != 2 || procs[0].PID != 4120 || bsInstanceOf(procs[0].Cmdline) != "Pie64_1" || bsInstanceOf(procs[1].Cmdline) != "Rvc64" {
		t.Fatalf("procs: %+v", procs)
	}
	if one := parseWinProcs([]byte(`{"ProcessId":7,"CommandLine":"HD-Player.exe"}`)); len(one) != 1 || bsInstanceOf(one[0].Cmdline) != "" {
		t.Fatalf("one bare object: %+v", one)
	}
	if parseWinProcs([]byte("  ")) != nil {
		t.Fatal("no processes is an empty list")
	}
}

func TestMapSerial(t *testing.T) {
	mumu := emuFound{Host: "mumu", Label: "MuMu Player 12", Inst: []EmuInstance{{ID: "0", Name: "MuMu Player 12", Port: 16384, Running: true}, {ID: "1", Name: "M2", Port: 16416}}}
	ld := emuFound{Host: "ldplayer", Label: "LDPlayer 9", Inst: []EmuInstance{{ID: "0", Name: "LDPlayer", Port: 5555}}}
	bs := emuFound{Host: "bluestacks", Label: "BlueStacks 5", Inst: []EmuInstance{{ID: "Pie64", Name: "Pie64", Port: 5555}}}
	bsOn := bs
	bsOn.Inst = []EmuInstance{{ID: "Pie64", Name: "Pie64", Port: 5555, Running: true}}
	supported := []string{"MuMu Player 12", "LDPlayer 9"}

	cases := []struct {
		name, serial string
		found        []emuFound
		match        string // host:id, "" for none
		local, tcp   bool
		why          string // part of the reason, when no match
	}{
		{"mumu by port", "127.0.0.1:16384", []emuFound{mumu, ld}, "mumu:0", true, true, ""},
		{"mumu old port", "127.0.0.1:7555", []emuFound{mumu}, "mumu:0", true, true, ""},
		{"stopped instance", "127.0.0.1:16416", []emuFound{mumu}, "mumu:1", true, true, ""},
		{"emulator- serial", "emulator-5554", []emuFound{ld}, "ldplayer:0", true, false, ""},
		{"two on 5555 both stopped", "127.0.0.1:5555", []emuFound{ld, bs}, "", true, true, "2 emulator instances use port 5555"},
		{"two on 5555, one running", "127.0.0.1:5555", []emuFound{ld, bsOn}, "bluestacks:Pie64", true, true, ""},
		{"nothing on the port", "127.0.0.1:21503", []emuFound{mumu}, "", true, true, "No emulator instance found on port 21503"},
		{"none installed", "127.0.0.1:16384", nil, "", true, true, "None of MuMu Player 12 or LDPlayer 9 is installed"},
		{"remote", "192.168.1.50:16384", []emuFound{mumu}, "", false, true, "another computer"},
		{"usb", "R58M12ABCDE", []emuFound{mumu}, "", false, false, "USB"},
	}
	for _, c := range cases {
		m := mapSerial(c.serial, c.found, supported)
		got := ""
		if m.Match != nil {
			got = m.Match.Host + ":" + m.Match.ID
		}
		if got != c.match || m.Local != c.local || m.TCP != c.tcp || !strings.Contains(m.Why, c.why) {
			t.Errorf("%s: got %q local=%v tcp=%v why=%q", c.name, got, m.Local, m.TCP, m.Why)
		}
		if info := m.info(); info.Mapped != (m.Match != nil) {
			t.Errorf("%s: info %+v", c.name, info)
		}
	}
	if m := mapSerial("127.0.0.1:5555", nil, nil); !strings.Contains(m.Why, "not supported") {
		t.Errorf("no back ends on this OS: %q", m.Why)
	}
}
