function filterSummaryByRole(summary, role) {
    if (role === "admin") {
        // admin nhận tất cả dữ liệu chi tiết
        return summary;
    }

    // user chỉ nhận dữ liệu cơ bản
    return {
        books: {
            total: summary.books.total,
            vip: summary.books.vip,
            paid: summary.books.paid,
            completed: summary.books.completed,
            topViewed: summary.books.topViewed
        },
        chapters: { total: summary.chapters.total },
        interactions: summary.interactions,
        usersReading: {
            totalRecords: summary.usersReading.totalRecords,
            completedBooks: summary.usersReading.completedBooks
        }
    };
}


const express = require('express');
const paypal = require('paypal-rest-sdk');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// --- Firebase Admin ---
const serviceAccount = require('/etc/secrets/serviceAccountKey.json');
const OpenAI = require("openai");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
const cors = require("cors");
app.use(cors());


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

function summarizeData({
    books,
    chapters,
    comments,
    ratings,
    favorites,
    readingHistory,
    payments,
    avatarFrames
}) {
    const bookList = Object.values(books || {});
    const chapterList = Object.values(chapters || {});
    const commentList = Object.values(comments || {});
    const ratingList = Object.values(ratings || {});
    const paymentList = Object.values(payments || {});
    const historyList = Object.values(readingHistory || {});
    const frameList = Object.values(avatarFrames || {});

    // Tổng hợp chi tiết sách (tên, tác giả, vip/paid, views)
    const detailedBooks = bookList.map(b => ({
        Id: b.Id,
        Title: b.Title,
        AuthorId: b.AuthorId,
        IsVIP: b.IsVIP,
        IsPaid: b.IsPaid,
        IsCompleted: b.IsCompleted,
        Views: b.Views || 0,
        Chapters: chapterList.filter(c => c.BookId === b.Id).map(c => ({
            Id: c.Id,
            Title: c.Title
        }))
    }));

    return {
        books: {
            total: bookList.length,
            vip: bookList.filter(b => b.IsVIP).length,
            paid: bookList.filter(b => b.IsPaid).length,
            completed: bookList.filter(b => b.IsCompleted).length,
            topViewed: bookList
                .sort((a, b) => (b.Views || 0) - (a.Views || 0))
                .slice(0, 5)
                .map(b => b.Title),
            detailed: detailedBooks // THÊM chi tiết cho admin
        },
        chapters: {
            total: chapterList.length,
            detailed: chapterList.map(c => ({
                Id: c.Id,
                Title: c.Title,
                BookId: c.BookId
            }))
        },
        interactions: {
            comments: commentList.length,
            ratings: ratingList.length,
            favorites: Object.keys(favorites || {}).length
        },
        usersReading: {
            totalRecords: historyList.length,
            completedBooks: historyList.filter(h => h.IsCompleted).length,
            detailed: historyList // admin có thể xem chi tiết từng user
        },
        revenue: {
            totalUSD: paymentList.reduce((sum, p) => sum + (p.amount || 0), 0),
            totalXu: paymentList.reduce((sum, p) => sum + (p.xuReceived || 0), 0),
            totalPayments: paymentList.length,
            detailed: paymentList // admin xem chi tiết từng giao dịch
        },
        avatarFrames: {
            total: frameList.length,
            vip: frameList.filter(f => f.Type === "vip").length,
            normal: frameList.filter(f => f.Type === "thuong").length
        }
    };
}

app.post("/ai-ask", async (req, res) => {
    const { question, userId } = req.body;

    if (!question || !userId) {
        return res.status(400).json({ error: "Thiếu question hoặc userId" });
    }

    try {
        // ===== 1. LẤY ROLE TỪ FIREBASE =====
        const userSnap = await db.ref(`Users/${userId}`).once("value");
        const userData = userSnap.val();

        if (!userData) {
            return res.status(404).json({ error: "User không tồn tại" });
        }
        const role = (userData.Role || "user").toLowerCase(); // luôn lowercase

        // ===== 2. LOAD DỮ LIỆU =====
        const [
            booksSnap,
            chaptersSnap,
            commentsSnap,
            ratingsSnap,
            favoritesSnap,
            historySnap,
            paymentsSnap,
            avatarFramesSnap
        ] = await Promise.all([
            db.ref("Books").once("value"),
            db.ref("Chapters").once("value"),
            db.ref("Comments").once("value"),
            db.ref("Ratings").once("value"),
            db.ref("Favorites").once("value"),
            db.ref("ReadingHistory").once("value"),
            db.ref("Payments").once("value"),
            db.ref("AvatarFrames").once("value")
        ]);

        const summary = summarizeData({
            books: booksSnap.val(),
            chapters: chaptersSnap.val(),
            comments: commentsSnap.val(),
            ratings: ratingsSnap.val(),
            favorites: favoritesSnap.val(),
            readingHistory: historySnap.val(),
            payments: paymentsSnap.val(),
            avatarFrames: avatarFramesSnap.val()
        });

        // ===== 3. LỌC THEO ROLE =====
        let filteredSummary = filterSummaryByRole(summary, role);

        // ===== 4. THÊM TÍNH NĂNG “WOW” =====
        if (role === "user") {
            // Gợi ý 5 sách dựa trên lịch sử đọc + topViewed + favorites
            const historyList = Object.values(historySnap.val() || {});
            const favoriteList = Object.values(favoritesSnap.val() || {});

            const readBookIds = historyList.map(h => h.BookId);
            const favoriteBookIds = favoriteList.map(f => f.BookId);

            const allBooks = Object.values(booksSnap.val() || {});

            // Gợi ý sách chưa đọc, ưu tiên favorite + topViewed
            const suggestions = allBooks
                .filter(b => !readBookIds.includes(b.Id))
                .sort((a, b) => {
                    const scoreA = (favoriteBookIds.includes(a.Id) ? 50 : 0) + (a.Views || 0);
                    const scoreB = (favoriteBookIds.includes(b.Id) ? 50 : 0) + (b.Views || 0);
                    return scoreB - scoreA;
                })
                .slice(0, 5)
                .map(b => b.Title);

            filteredSummary.suggestedBooks = suggestions;
        }

        if (role === "admin") {
            // Cảnh báo ví dụ:
            const warnings = [];
            const totalUSD = summary.revenue.totalUSD;

            // Sách VIP ít đọc
            const vipLowRead = Object.values(booksSnap.val() || {}).filter(b => b.IsVIP && (b.Views || 0) < 10);
            if (vipLowRead.length) warnings.push(`Có ${vipLowRead.length} sách VIP ít lượt đọc.`);

            // Doanh thu thấp
            if (totalUSD < 50) warnings.push(`Doanh thu tuần này thấp: $${totalUSD}.`);

            // Tác giả nổi bật (nhiều người tặng xu)
            const payments = Object.values(paymentsSnap.val() || {});
            const xuTặngTheoTacGia = {};
            payments.forEach(p => {
                if (p.toAuthorId) {
                    xuTặngTheoTacGia[p.toAuthorId] = (xuTặngTheoTacGia[p.toAuthorId] || 0) + (p.xuReceived || 0);
                }
            });
            const topAuthors = Object.entries(xuTặngTheoTacGia)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([authorId, xu]) => `Tác giả ${authorId} nhận ${xu} xu`);

            filteredSummary.adminWarnings = { warnings, topAuthors };
        }

        // ===== 5. SYSTEM PROMPT =====
        const systemPrompt = getSystemPrompt(role);

        // ===== 6. GỌI AI =====
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                {
                    role: "user",
                    content: `
Dữ liệu hệ thống (đã tóm tắt):
${JSON.stringify(filteredSummary, null, 2)}

Câu hỏi:
${question}
`
                }
            ]
        });

        // ===== 7. LOG AI =====
        await db.ref("AI_Logs").push({
            userId,
            role,
            question,
            time: Date.now()
        });

        res.json({
            role,
            answer: completion.choices[0].message.content,
            summary: filteredSummary
        });

    } catch (err) {
        console.error("AI ERROR:", err);
        res.status(500).json({ error: "AI processing failed" });
    }
});



if (!process.env.OPENAI_API_KEY) {
    console.error("❌ Thiếu OPENAI_API_KEY");
}
app.get("/", (req, res) => {
    res.send("✅ Booknet Payment + AI Server is running");
});
function getSystemPrompt(role) {
    if (role === "admin") {
        return `
Bạn là AI trợ lý QUẢN TRỊ cho hệ thống đọc sách Booknet.

Nhiệm vụ:
- Phân tích số liệu hệ thống
- Trình bày báo cáo rõ ràng, có số liệu
- Phát hiện vấn đề tiềm ẩn
- Đề xuất cải thiện hệ thống
- Trả lời theo phong cách báo cáo quản trị
`;
    }

    return `
Bạn là AI trợ lý đọc sách Booknet cho người dùng.

Nhiệm vụ:
- Gợi ý sách phù hợp
- Trả lời câu hỏi về sách
- Giải thích dữ liệu một cách đơn giản
- KHÔNG tiết lộ dữ liệu nội bộ hệ thống
`;
}
