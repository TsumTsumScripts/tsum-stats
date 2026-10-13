//go:build !windows && !darwin

package starter

// No emulator this computer can restart from outside Android: watch mode
// uses adb only here.
func hostEmulators() []Emulator { return nil }
