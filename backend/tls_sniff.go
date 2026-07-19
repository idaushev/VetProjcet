package main

import (
	"crypto/tls"
	"net"
)

// sniffConn — TCP-соединение, у которого уже прочитан первый байт.
// Реализует net.Conn: при первом Read() возвращает сохранённый байт,
// а дальше читает из оригинального соединения как обычно.
type sniffConn struct {
	net.Conn
	first byte
	used  bool
}

func (c *sniffConn) Read(p []byte) (int, error) {
	if !c.used && len(p) > 0 {
		c.used = true
		p[0] = c.first
		if len(p) == 1 {
			return 1, nil
		}
		n, err := c.Conn.Read(p[1:])
		return n + 1, err
	}
	return c.Conn.Read(p)
}

// sniffListener слушает один TCP-порт и по первому байту определяет
// тип соединения:
//   - 0x16 (TLS ClientHello) → оборачивает в tls.Server → HTTPS
//   - всё остальное         → возвращает как есть → HTTP (редирект на HTTPS)
//
// Это позволяет иметь единый порт вместо двух (HTTP + HTTPS).
type sniffListener struct {
	net.Listener
	tlsCfg *tls.Config
}

// newSniffListener создаёт listener на addr с определением протокола.
func newSniffListener(addr string, tlsCfg *tls.Config) (*sniffListener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	return &sniffListener{Listener: ln, tlsCfg: tlsCfg}, nil
}

func (l *sniffListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}

		var buf [1]byte
		if _, err := conn.Read(buf[:]); err != nil {
			conn.Close()
			continue // битое соединение — пропускаем
		}

		sc := &sniffConn{Conn: conn, first: buf[0]}

		// TLS ClientHello record type = 0x16
		if buf[0] == 0x16 {
			return tls.Server(sc, l.tlsCfg), nil
		}

		// Обычный HTTP — вернём как есть;
		// http.Server увидит r.TLS == nil и применит редирект.
		return sc, nil
	}
}
