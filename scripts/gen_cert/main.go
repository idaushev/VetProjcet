// gen_cert — генератор TLS-сертификатов для VetClinic.
//
// Запуск:
//
//	go run ./scripts/gen_cert/
//
// Схема двухуровневая:
//
//	rootCA.pem          — корневой CA, устанавливается на планшет как доверенный
//	data/rootCA-key.pem — приватный ключ CA, никому не передаётся
//	data/cert.pem       — серверный сертификат, подписан корневым CA
//	data/key.pem        — приватный ключ сервера
//
// Серверный сертификат один на оба окружения — тестовое (start.bat, порт 8444)
// и боевое (prod/start.bat, порт 8443): сертификат привязан к именам и IP, а не
// к портам. Копия для боевого сервера кладётся в prod/data автоматически.
//
// Корневой CA создаётся один раз и переиспользуется при последующих запусках.
// Поэтому при смене IP сервера достаточно перевыпустить серверный сертификат —
// переустанавливать корневой на планшете не нужно.
//
// Чтобы принудительно пересоздать корневой CA (потребует переустановки на всех
// планшетах), удалите rootCA.pem и data/rootCA-key.pem.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"time"
)

const (
	rootCertPath = "rootCA.pem"
	rootKeyPath  = "data/rootCA-key.pem"
	certPath     = "data/cert.pem"
	keyPath      = "data/key.pem"

	// Боевой сервер запускается из prod/ и читает сертификат из своей
	// папки data. Оба сервера (тестовый 8444 и боевой 8443) работают с
	// одним и тем же сертификатом: сертификат привязан к адресам, а не к
	// портам. Чтобы после перевыпуска не забывать копировать файлы руками,
	// зеркалим их в prod/data — если эта папка существует.
	prodCertPath = "prod/data/cert.pem"
	prodKeyPath  = "prod/data/key.pem"

	rootValidity = 10 * 365 * 24 * time.Hour // 10 лет
	certValidity = 825 * 24 * time.Hour      // 825 дней — предел, который принимают мобильные браузеры
)

func main() {
	if err := os.MkdirAll("data", 0o755); err != nil {
		fatalf("mkdir data: %v", err)
	}

	rootCert, rootKey, created, err := loadOrCreateCA()
	if err != nil {
		fatalf("корневой CA: %v", err)
	}

	ips := localIPs()
	dnsNames := []string{"localhost", "vetclinic.local"}

	if err := issueServerCert(rootCert, rootKey, ips, dnsNames); err != nil {
		fatalf("серверный сертификат: %v", err)
	}

	mirrored, err := mirrorToProd()
	if err != nil {
		fatalf("копирование в prod/data: %v", err)
	}

	report(created, mirrored, ips, dnsNames, rootCert.NotAfter)
}

// loadOrCreateCA читает корневой CA с диска, а если его нет — создаёт новый.
// Возвращаемый флаг сообщает, был ли CA создан заново.
func loadOrCreateCA() (*x509.Certificate, *ecdsa.PrivateKey, bool, error) {
	cert, key, err := loadCA()
	if err == nil {
		return cert, key, false, nil
	}
	if !os.IsNotExist(err) {
		return nil, nil, false, err
	}

	cert, key, err = createCA()
	if err != nil {
		return nil, nil, false, err
	}
	return cert, key, true, nil
}

// loadCA читает существующую пару rootCA.pem + rootCA-key.pem.
// Если хотя бы одного файла нет, возвращает ошибку, для которой os.IsNotExist == true.
func loadCA() (*x509.Certificate, *ecdsa.PrivateKey, error) {
	certPEM, err := os.ReadFile(rootCertPath)
	if err != nil {
		return nil, nil, err
	}
	keyPEM, err := os.ReadFile(rootKeyPath)
	if err != nil {
		return nil, nil, err
	}

	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil || certBlock.Type != "CERTIFICATE" {
		return nil, nil, fmt.Errorf("%s не содержит сертификат в формате PEM", rootCertPath)
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("разбор %s: %w", rootCertPath, err)
	}
	if !cert.IsCA {
		return nil, nil, fmt.Errorf("%s не является CA-сертификатом", rootCertPath)
	}

	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, nil, fmt.Errorf("%s не содержит ключ в формате PEM", rootKeyPath)
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("разбор %s: %w", rootKeyPath, err)
	}

	return cert, key, nil
}

// createCA генерирует новый корневой CA и сохраняет его на диск.
func createCA() (*x509.Certificate, *ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("генерация ключа: %w", err)
	}

	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "VetClinic Local CA",
			Organization: []string{"VetClinic"},
			Country:      []string{"KZ"},
		},
		NotBefore: time.Now().Add(-time.Hour),
		NotAfter:  time.Now().Add(rootValidity),

		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("выпуск сертификата: %w", err)
	}

	if err := writePEM(rootCertPath, "CERTIFICATE", der, 0o644); err != nil {
		return nil, nil, err
	}

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, fmt.Errorf("сериализация ключа: %w", err)
	}
	if err := writePEM(rootKeyPath, "EC PRIVATE KEY", keyDER, 0o600); err != nil {
		return nil, nil, err
	}

	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

// issueServerCert выпускает серверный сертификат, подписанный корневым CA.
func issueServerCert(rootCert *x509.Certificate, rootKey *ecdsa.PrivateKey, ips []net.IP, dnsNames []string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("генерация ключа: %w", err)
	}

	serial, err := randomSerial()
	if err != nil {
		return err
	}

	notAfter := time.Now().Add(certValidity)
	// Серверный сертификат не может пережить выпустивший его CA.
	if notAfter.After(rootCert.NotAfter) {
		notAfter = rootCert.NotAfter
	}

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "VetClinic Local",
			Organization: []string{"VetClinic"},
			Country:      []string{"KZ"},
		},
		NotBefore: time.Now().Add(-time.Hour),
		NotAfter:  notAfter,

		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,

		IPAddresses: ips,
		DNSNames:    dnsNames,
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, rootCert, &key.PublicKey, rootKey)
	if err != nil {
		return fmt.Errorf("выпуск сертификата: %w", err)
	}

	if err := writePEM(certPath, "CERTIFICATE", der, 0o644); err != nil {
		return err
	}

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return fmt.Errorf("сериализация ключа: %w", err)
	}
	return writePEM(keyPath, "EC PRIVATE KEY", keyDER, 0o600)
}

// localIPs собирает адреса этой машины для SAN сертификата.
//
// IPv6 намеренно ограничен петлёй ::1: у временных и link-local адресов короткий
// срок жизни, и сертификат, привязанный к ним, быстро протухает. Планшет в
// локальной сети ходит по IPv4.
func localIPs() []net.IP {
	ips := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}

	ifaces, err := net.Interfaces()
	if err != nil {
		return ips
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipNet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			ips = append(ips, ip4)
		}
	}
	return ips
}

// mirrorToProd копирует свежий серверный сертификат в prod/data.
// Если папки prod/data нет (боевое окружение ещё не развёрнуто), молча
// пропускаем — это не ошибка. Возвращает true, если файлы скопированы.
func mirrorToProd() (bool, error) {
	if _, err := os.Stat("prod/data"); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}

	if err := copyFile(certPath, prodCertPath, 0o644); err != nil {
		return false, err
	}
	if err := copyFile(keyPath, prodKeyPath, 0o600); err != nil {
		return false, err
	}
	return true, nil
}

func copyFile(src, dst string, perm os.FileMode) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("чтение %s: %w", src, err)
	}
	if err := os.WriteFile(dst, data, perm); err != nil {
		return fmt.Errorf("запись %s: %w", dst, err)
	}
	return nil
}

func randomSerial() (*big.Int, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("генерация серийного номера: %w", err)
	}
	return serial, nil
}

func writePEM(path, blockType string, der []byte, perm os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return fmt.Errorf("создание %s: %w", path, err)
	}
	defer f.Close()

	if err := pem.Encode(f, &pem.Block{Type: blockType, Bytes: der}); err != nil {
		return fmt.Errorf("запись %s: %w", path, err)
	}
	return nil
}

func report(caCreated, mirrored bool, ips []net.IP, dnsNames []string, caExpiry time.Time) {
	fmt.Println()
	fmt.Println("✅ Сертификаты выпущены")
	fmt.Println()

	if caCreated {
		fmt.Println("Создан НОВЫЙ корневой CA:")
		fmt.Printf("  %s          — установите на планшет как доверенный\n", rootCertPath)
		fmt.Printf("  %s — приватный ключ CA, храните только на сервере\n", rootKeyPath)
		fmt.Println()
		fmt.Println("⚠️  Корень изменился. На каждом планшете нужно:")
		fmt.Println("     1. Удалить старый сертификат VetClinic")
		fmt.Println("        (Настройки → Безопасность → Учётные данные → Пользовательские)")
		fmt.Println("     2. Установить новый rootCA.pem")
	} else {
		fmt.Printf("Использован существующий корневой CA (%s, действует до %s).\n",
			rootCertPath, caExpiry.Format("02.01.2006"))
		fmt.Println("Переустанавливать его на планшетах не нужно.")
	}

	fmt.Println()
	fmt.Println("Серверный сертификат:")
	fmt.Printf("  %s  — сертификат\n", certPath)
	fmt.Printf("  %s   — приватный ключ\n", keyPath)
	if mirrored {
		fmt.Printf("  скопирован в %s и %s (боевой сервер)\n", prodCertPath, prodKeyPath)
	}
	fmt.Println()
	fmt.Println("Адреса в сертификате:")
	for _, name := range dnsNames {
		fmt.Printf("  ✓ %s\n", name)
	}
	for _, ip := range ips {
		fmt.Printf("  ✓ %s\n", ip)
	}
	fmt.Println()
	fmt.Println("Дальше (оба сервера могут работать одновременно):")
	fmt.Println("  тестовый: start.bat          → https://<IP>:8444")
	fmt.Println("  боевой:   prod\\start.bat     → https://<IP>:8443")
	fmt.Println()
	fmt.Println("Если IP сервера сменился — просто запустите gen_cert снова.")
}

func fatalf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "ОШИБКА: "+format+"\n", args...)
	os.Exit(1)
}
