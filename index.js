const express = require('express');
const paypal = require('paypal-rest-sdk');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// --- Firebase Admin ---
const serviceAccount = require('/etc/secrets/serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://docsach-2e95b-default-rtdb.firebaseio.com/"
});
const db = admin.database();

// --- PayPal config ---
paypal.configure({
    mode: process.env.PAYPAL_MODE, // sandbox hoặc live
    client_id: process.env.PAYPAL_CLIENT_ID,
    client_secret: process.env.PAYPAL_CLIENT_SECRET,
});

// --- Render public URL (KHÔNG DÙNG NGROK NỮA) ---
const RENDER_URL = "https://booknet-payments.onrender.com";

// --- Tạo thanh toán ---
app.post('/create-payment', (req, res) => {
    const { amount, userId } = req.body;

    const create_payment_json = {
        intent: 'sale',
        payer: { payment_method: 'paypal' },
        redirect_urls: {
            return_url: `${RENDER_URL}/success?userId=${userId}&amount=${amount}`,
            cancel_url: `${RENDER_URL}/cancel`,
        },
        transactions: [{
            item_list: { items: [{ name: 'Nạp xu Booknet', price: amount, currency: 'USD', quantity: 1 }] },
            amount: { currency: 'USD', total: amount },
            description: `Nạp xu cho user ${userId}`,
        }],
    };

    paypal.payment.create(create_payment_json, (error, payment) => {
        if (error) {
            console.error(error);
            res.status(500).send('Lỗi tạo thanh toán');
        } else {
            const approvalUrl = payment.links.find(link => link.rel === 'approval_url');
            res.json({ paymentUrl: approvalUrl.href });
        }
    });
});

// --- Xử lý thanh toán thành công ---
app.get('/success', async (req, res) => {
    const { PayerID: payerId, paymentId, userId, amount } = req.query;

    const execute_payment_json = {
        payer_id: payerId,
        transactions: [{ amount: { currency: 'USD', total: amount } }],
    };

    paypal.payment.execute(paymentId, execute_payment_json, async (error, payment) => {
        if (error) {
            console.error(error.response);
            return res.send('❌ Thanh toán thất bại');
        }

        // ======== TÍNH XU ========
        const xuThem = parseFloat(amount) * 100;
        const xuRef = db.ref(`Users/${userId}/xu`);
        const snapshot = await xuRef.once('value');
        const currentXu = snapshot.val() || 0;
        const newXu = currentXu + xuThem;

        await xuRef.set(newXu);

        // ======== GHI LỊCH SỬ NẠP ========
        const paymentRecord = {
            userId,
            paymentId,
            payerId,
            amount: parseFloat(amount),
            xuReceived: xuThem,
            status: "success",
            method: "paypal",
            time: Date.now()
        };

        await db.ref("Payments").push(paymentRecord);

        // ======== GHI LỊCH SỬ GIAO DỊCH ========
        const transactionRecord = {
            type: "topup",
            method: "paypal",
            amount: xuThem,
            before: currentXu,
            after: newXu,
            time: Date.now()
        };

        await db.ref(`Transactions/${userId}`).push(transactionRecord);

        // Trang thành công
        res.send(`
            <!DOCTYPE html>
            <html lang="vi">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Thanh toán thành công</title>
                <style>
                    body {
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        background: linear-gradient(135deg, #6EE7B7, #3B82F6);
                        color: #fff;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                    }
                    .container {
                        text-align: center;
                        background: rgba(0,0,0,0.3);
                        padding: 40px 60px;
                        border-radius: 20px;
                        box-shadow: 0 8px 16px rgba(0,0,0,0.3);
                    }
                    h1 { font-size: 48px; margin-bottom: 10px; }
                    p { font-size: 20px; margin: 10px 0; }
                    .btn {
                        display: inline-block;
                        margin-top: 20px;
                        padding: 12px 30px;
                        font-size: 18px;
                        color: #fff;
                        background-color: #10B981;
                        border-radius: 10px;
                        text-decoration: none;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Thanh toán thành công!</h1>
                    <p>Bạn đã nạp <b>${xuThem}</b> xu.</p>
                    <p>Tổng xu mới: <b>${newXu}</b></p>
                    <a class="btn" href="booknet://home">Quay lại ứng dụng</a>
                </div>
            </body>
            </html>
        `);
    });
});

// --- Hủy thanh toán ---
app.get('/cancel', (req, res) => res.send('Bạn đã hủy thanh toán!'));

// --- Khởi động server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Server đang chạy tại port ${PORT}`);
    console.log(`🌐 Domain public: ${RENDER_URL}`);
});

app.post('/pay-author', async (req, res) => {
    try {
        const { userId, totalXuVIP } = req.body;
        if (!userId || !totalXuVIP) return res.status(400).send("Thiếu dữ liệu");

        // Lấy tác giả
        const userSnapshot = await db.ref(`Users/${userId}`).once('value');
        const user = userSnapshot.val();
        if (!user || !user.paypalEmail) return res.status(400).send("Tác giả chưa có PayPal");

        // Quy đổi xu sang USD và 65% cho tác giả
        const usd = ((totalXuVIP * 0.65) / 100).toFixed(2); // 1 USD = 100 xu

        const create_payment_json = {
            intent: 'sale',
            payer: { payment_method: 'paypal' },
            redirect_urls: {
                return_url: `${RENDER_URL}/success-author?userId=${userId}&amount=${usd}`,
                cancel_url: `${RENDER_URL}/cancel`,
            },
            transactions: [{
                item_list: { items: [{ name: 'Thanh toán quyền lợi tác giả', price: usd, currency: 'USD', quantity: 1 }] },
                amount: { currency: 'USD', total: usd },
                payee: { email: user.paypalEmail },
                description: `Thanh toán quyền lợi tác giả ${user.Username}`,
            }],
        };

        paypal.payment.create(create_payment_json, (error, payment) => {
            if (error) {
                console.error(error);
                return res.status(500).send("Lỗi tạo thanh toán PayPal");
            }
            const approvalUrl = payment.links.find(link => link.rel === 'approval_url');
            res.json({ paymentUrl: approvalUrl.href });
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi server khi thanh toán tác giả");
    }
});

app.get('/success-author', async (req, res) => {
    const { PayerID: payerId, paymentId, userId, amount } = req.query;

    const execute_payment_json = {
        payer_id: payerId,
        transactions: [{ amount: { currency: 'USD', total: amount } }],
    };

    paypal.payment.execute(paymentId, execute_payment_json, async (error, payment) => {
        if (error) return res.send('❌ Thanh toán thất bại');

        // ===== Cập nhật sách đã thanh toán =====
        const booksRef = db.ref("Books");
        const booksSnapshot = await booksRef.once('value');
        const books = booksSnapshot.val() || {};

        for (const [bookId, book] of Object.entries(books)) {
            if (book.UploaderId === userId && book.IsVIP && !book.IsPaid) {
                await db.ref(`Books/${bookId}`).update({ IsPaid: true });
            }
        }

        // ===== Thêm thông báo cho tác giả =====
        const notifRef = db.ref(`Notifications/${userId}`);
        const newNotif = {
            createdAt: Date.now(),
            message: `Người quản trị đã thanh toán quyền lợi của bạn (${amount} USD)`,
            read: false,
            title: "Bạn vừa nhận tiền từ sách VIP",
            type: "author_payment",
        };
        await notifRef.push(newNotif);

        res.send(`
      <h2>Thanh toán quyền lợi tác giả thành công!</h2>
      <p>Số tiền: $${amount} đã chuyển vào PayPal của tác giả.</p>
      <a href="booknet://home">Quay lại ứng dụng</a>
    `);
    });
});
