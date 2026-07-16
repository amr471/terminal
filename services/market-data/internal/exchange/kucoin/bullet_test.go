package kucoin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const bulletSample = `{"code":"200000","data":{"token":"tok123","instanceServers":[
  {"endpoint":"wss://ws-api-futures.kucoin.com/","encrypt":true,"protocol":"websocket","pingInterval":18000,"pingTimeout":10000}]}}`

func TestParseBullet(t *testing.T) {
	b, err := parseBullet([]byte(bulletSample))
	if err != nil {
		t.Fatal(err)
	}
	if b.token != "tok123" || b.endpoint != "wss://ws-api-futures.kucoin.com/" {
		t.Fatalf("bullet = %+v", b)
	}
	if b.pingInterval != 18*time.Second {
		t.Fatalf("pingInterval = %v", b.pingInterval)
	}
}

func TestParseBulletRejectsEmpty(t *testing.T) {
	if _, err := parseBullet([]byte(`{"code":"200000","data":{"token":"","instanceServers":[]}}`)); err == nil {
		t.Fatal("expected error on missing token/servers")
	}
}

func TestFetchBulletOverHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != bulletPath {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(bulletSample))
	}))
	defer srv.Close()

	b, err := fetchBullet(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if b.token != "tok123" {
		t.Fatalf("token = %q", b.token)
	}
}

func TestDialURLAppendsParams(t *testing.T) {
	b := bullet{endpoint: "wss://ws-api-futures.kucoin.com/", token: "tok"}
	got := b.dialURL("cid1")
	want := "wss://ws-api-futures.kucoin.com/?token=tok&connectId=cid1"
	if got != want {
		t.Fatalf("dialURL = %q, want %q", got, want)
	}
	// endpoint already carrying a query keeps a single ? and uses &.
	b2 := bullet{endpoint: "wss://x/?a=1", token: "tok"}
	if got := b2.dialURL("c"); got != "wss://x/?a=1&token=tok&connectId=c" {
		t.Fatalf("dialURL with query = %q", got)
	}
}
