package starter

import (
	"errors"
	"testing"
)

func TestUpdateState(t *testing.T) {
	s := &Starter{version: "0.14"}
	if st := s.updateState(); !st.Disabled || st.CanRestart {
		t.Fatalf("no updater: %+v", st)
	}
	latest, fail := "0.15", error(nil)
	s.SetUpdater(Updater{
		Latest:      func() (string, error) { return latest, fail },
		Newer:       func(a, b string) bool { return a > b },
		RestartCode: 75,
	})
	if st := s.checkUpdate(); !st.Available || st.Latest != "0.15" || !st.CanRestart || st.Checked == "" {
		t.Fatalf("newer out: %+v", st)
	}
	fail = errors.New("offline")
	if st := s.checkUpdate(); st.Error != "offline" || st.Latest != "0.15" {
		t.Fatalf("a failed check keeps the last answer: %+v", st)
	}
	if s.RestartCode() != 0 {
		t.Fatal("no restart before an update is applied")
	}
}
