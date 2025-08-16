require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const port = 3000;

// middleware
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vlrcl7k.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// JWT verification middleware
const verifyToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).send({ message: "Unauthorized" });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).send({ message: "Unauthorized" });
    req.decoded = decoded;
    next();
  });
};

async function run() {
  try {
    const db = client.db("xpensoData");
    const expenseCollection = db.collection("expenseCollection");
    const userCollection = db.collection("userCollection");

    // JWT creation
    app.post("/jwt", async (req, res) => {
      const { email } = req.body;
      const token = jwt.sign({ email }, process.env.JWT_SECRET, {
        expiresIn: "365d",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: false,
          sameSite: "lax",
        })
        .send({ success: true });
    });

    // Logout
    app.post("/logout", (req, res) => {
      res.clearCookie("token", { httpOnly: true, secure: false });
      res.send({ message: "Logged out successfully" });
    });

    // user post
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.role = "user";
      const existingUser = await userCollection.findOne({
        email: userData?.email,
      });
      if (existingUser) {
        return res.send({ message: "User Already Exist" });
      }
      const result = await userCollection.insertOne(userData);
      res.send(result);
    });

    // Add expense
    app.post("/expenses", verifyToken, async (req, res) => {
      const { title, amount, category, date, userName, userPhoto } = req.body;
      const userEmail = req.decoded.email; // take from JWT

      const newExpense = {
        title,
        amount,
        category,
        date: new Date(date),
        userName,
        userEmail,
        userPhoto,
        createdAt: new Date(),
      };

      const result = await expenseCollection.insertOne(newExpense);
      res.send(result);
    });

    // Get expenses for logged-in user
    app.get("/my-expense", verifyToken, async (req, res) => {
      const userEmail = req.decoded.email;
      const { category } = req.query; // get category from query param

      try {
        const query = { userEmail };
        if (category && category !== "All") {
          query.category = category; // filter by category if provided
        }

        const result = await expenseCollection
          .find(query)
          .sort({ date: -1 })
          .toArray();

        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch expenses" });
      }
    });

    // Get single expense by ID (for edit page)
    app.get("/expenses/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const userEmail = req.decoded.email;

      try {
        const expense = await expenseCollection.findOne({
          _id: new ObjectId(id),
          userEmail,
        });
        if (!expense)
          return res.status(404).send({ message: "Expense not found" });
        res.send(expense);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Update expense by ID
    app.patch("/expenses/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const userEmail = req.decoded.email; // from JWT
      const { title, amount, category, date } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid expense ID" });
      }

      // Build the update object
      const updateData = {};
      if (title) updateData.title = title;
      if (amount) updateData.amount = amount;
      if (category) updateData.category = category;
      if (date) updateData.date = new Date(date);

      try {
        const result = await expenseCollection.updateOne(
          { _id: new ObjectId(id), userEmail }, // only allow editing own expense
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res
            .status(403)
            .send({ message: "Forbidden: cannot update this expense" });
        }

        res.send({ message: "Expense updated successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Delete expense
    app.delete("/expenses/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const userEmail = req.decoded.email;

      // ensure user can only delete their own expense
      const result = await expenseCollection.deleteOne({
        _id: new ObjectId(id),
        userEmail,
      });
      if (result.deletedCount === 0)
        return res.status(403).send({ message: "Forbidden" });
      res.send({ message: "Expense deleted successfully" });
    });

    // Quick Stats
    app.get("/quick-stats", verifyToken, async (req, res) => {
      const userEmail = req.decoded.email;

      try {
        const expenses = await expenseCollection.find({ userEmail }).toArray();

        if (!expenses.length) {
          return res.send({
            totalExpenses: 0,
            monthlyExpenses: 0,
            topCategory: "N/A",
            categoryData: [],
            trendData: [],
          });
        }

        //  Total Expenses
        const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);

        //  This Month Expenses (strictly current month & year)
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        const monthlyExpenses = expenses
          .filter((e) => {
            const d = new Date(e.date);
            return (
              d.getMonth() === currentMonth && d.getFullYear() === currentYear
            );
          })
          .reduce((sum, e) => sum + e.amount, 0);

        //  Category-wise expenses (Pie Chart)
        const categoryMap = {};
        expenses.forEach((e) => {
          categoryMap[e.category] = (categoryMap[e.category] || 0) + e.amount;
        });

        const categoryData = Object.keys(categoryMap).map((key) => ({
          name: key,
          value: categoryMap[key],
        }));

        // Top Category
        const topCategory =
          Object.entries(categoryMap).sort((a, b) => b[1] - a[1])[0]?.[0] ||
          "N/A";

        //  Monthly Trend (Jan - Dec of current year)
        const monthlyData = Array(12).fill(0);
        expenses.forEach((e) => {
          const d = new Date(e.date);
          if (d.getFullYear() === currentYear) {
            monthlyData[d.getMonth()] += e.amount;
          }
        });

        const trendData = monthlyData.map((amount, i) => ({
          month: new Date(0, i).toLocaleString("default", { month: "short" }),
          amount,
        }));

        res.send({
          totalExpenses,
          monthlyExpenses,
          topCategory,
          categoryData,
          trendData,
        });
      } catch (err) {
        console.error(" Quick Stats Error:", err.message);
        res.status(500).send({ error: "Failed to fetch stats" });
      }
    });

    // Recent Expenses Preview
    app.get("/recent-expenses", verifyToken, async (req, res) => {
      const userEmail = req.decoded.email;

      try {
        const recentExpenses = await expenseCollection
          .find({ userEmail })
          .sort({ date: -1 })
          .limit(5) // show last 5 expenses
          .toArray();

        res.send(recentExpenses);
      } catch (err) {
        console.error("Recent Expenses Error:", err.message);
        res.status(500).send({ error: "Failed to fetch recent expenses" });
      }
    });

    console.log(" MongoDB connected and backend running.");
  } finally {
    // client.close()  // keep connection alive
  }
}
run().catch(console.dir);

app.get("/", (req, res) => res.send("Hello, This is Xpenso"));

app.listen(port, () => console.log(`Xpenso running on port ${port}`));
