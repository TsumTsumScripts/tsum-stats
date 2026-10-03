package main

import "testing"

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"0.6", "0.5", true}, {"0.5", "0.5", false}, {"0.10", "0.9", true}, {"1.0", "0.9.9", true}, {"0.5", "0.5.1", false}, {"", "0.5", false}} {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestParsePin(t *testing.T) {
	kv := parsePin("# c\nversion=0.6\n\nurl_linux_amd64 = http://x/a=b\n")
	if kv["version"] != "0.6" || kv["url_linux_amd64"] != "http://x/a=b" {
		t.Errorf("got %v", kv)
	}
}
