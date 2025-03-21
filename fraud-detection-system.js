// models/Transaction.js
const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  receiverAddress: {
    type: String,
    required: true
  },
  country: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'flagged', 'rejected'],
    default: 'pending'
  },
  risk: {
    score: Number,
    factors: [String]
  }
});

module.exports = mongoose.model("Transaction", transactionSchema);

// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true
  },
  usualTransactionTimes: {
    type: [Number], // Array of hour values (0-23) when user typically transacts
    default: []
  },
  usualCountries: {
    type: [String],
    default: []
  },
  averageTransactionAmount: {
    type: Number,
    default: 0
  },
  transactionCount: {
    type: Number,
    default: 0
  },
  highRiskThreshold: {
    type: Number,
    default: 1000 // Default high amount threshold
  },
  frequencyThreshold: {
    count: {
      type: Number,
      default: 3
    },
    timeWindowHours: {
      type: Number,
      default: 24
    }
  }
});

module.exports = mongoose.model("User", userSchema);

// services/fraudDetectionService.js
const Transaction = require("../models/Transaction");
const User = require("../models/User");

class FraudDetectionService {
  
  async analyzeTransaction(transaction) {
    const riskFactors = [];
    let riskScore = 0;
    
    // Get user profile
    let user = await User.findOne({ userId: transaction.userId });
    
    // If user doesn't exist, create a new profile
    if (!user) {
      user = new User({ userId: transaction.userId });
      await user.save();
    }
    
    // Rule 1: Check if amount is high
    if (transaction.amount > user.highRiskThreshold) {
      riskFactors.push("high_amount");
      riskScore += 30;
    }
    
    // Rule 2: Check if transaction is to a foreign country
    if (user.usualCountries.length > 0 && !user.usualCountries.includes(transaction.country)) {
      riskFactors.push("unusual_country");
      riskScore += 25;
    }
    
    // Rule 3: Check if transaction time is unusual
    const transactionHour = new Date(transaction.timestamp).getHours();
    if (user.usualTransactionTimes.length > 0 && !user.usualTransactionTimes.includes(transactionHour)) {
      riskFactors.push("unusual_time");
      riskScore += 15;
    }
    
    // Rule 4: Check if transaction frequency is high with larger amounts
    const recentTransactions = await Transaction.find({
      userId: transaction.userId,
      timestamp: { 
        $gte: new Date(Date.now() - user.frequencyThreshold.timeWindowHours * 60 * 60 * 1000) 
      }
    });
    
    if (recentTransactions.length >= user.frequencyThreshold.count) {
      const highAmountRecent = recentTransactions.filter(t => t.amount > user.averageTransactionAmount * 1.5).length;
      
      if (highAmountRecent >= 2) {
        riskFactors.push("high_frequency_large_amounts");
        riskScore += 30;
      }
    }
    
    // Update user profile with this transaction data
    this.updateUserProfile(user, transaction);
    
    return {
      riskScore,
      riskFactors,
      status: this.determineTransactionStatus(riskScore)
    };
  }
  
  determineTransactionStatus(riskScore) {
    if (riskScore >= 70) return "rejected";
    if (riskScore >= 40) return "flagged";
    return "completed";
  }
  
  async updateUserProfile(user, transaction) {
    // Update average transaction amount
    const newAverage = (user.averageTransactionAmount * user.transactionCount + transaction.amount) / (user.transactionCount + 1);
    user.averageTransactionAmount = newAverage;
    
    // Increment transaction count
    user.transactionCount += 1;
    
    // Add transaction hour to usual times if not present
    const transactionHour = new Date(transaction.timestamp).getHours();
    if (!user.usualTransactionTimes.includes(transactionHour)) {
      user.usualTransactionTimes.push(transactionHour);
    }
    
    // Add country to usual countries if not present
    if (!user.usualCountries.includes(transaction.country)) {
      user.usualCountries.push(transaction.country);
    }
    
    // Save updated user profile
    await user.save();
  }
}

module.exports = new FraudDetectionService();

// controllers/fraudController.js
const Transaction = require("../models/Transaction");
const fraudDetectionService = require("../services/fraudDetectionService");

exports.analyzeTransaction = async (req, res) => {
  try {
    const { userId, amount, receiverAddress, country } = req.body;
    
    // Validate required fields
    if (!userId || !amount || !receiverAddress || !country) {
      return res.status(400).json({ 
        status: "error", 
        message: "Missing required fields" 
      });
    }
    
    // Create new transaction
    const transaction = new Transaction({
      userId,
      amount,
      receiverAddress,
      country,
      timestamp: new Date()
    });
    
    // Analyze for fraud
    const riskAnalysis = await fraudDetectionService.analyzeTransaction(transaction);
    
    // Update transaction with risk analysis
    transaction.risk = {
      score: riskAnalysis.riskScore,
      factors: riskAnalysis.riskFactors
    };
    transaction.status = riskAnalysis.status;
    
    // Save transaction
    await transaction.save();
    
    return res.status(200).json({
      status: "success",
      transaction: {
        id: transaction._id,
        amount,
        status: transaction.status,
        risk: transaction.risk
      }
    });
  } catch (error) {
    console.error("Error analyzing transaction:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to process transaction"
    });
  }
};

exports.getTransactionHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const transactions = await Transaction.find({ userId })
      .sort({ timestamp: -1 })
      .limit(20);
    
    return res.status(200).json({
      status: "success",
      transactions
    });
  } catch (error) {
    console.error("Error fetching transaction history:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch transaction history"
    });
  }
};

exports.updateRiskProfile = async (req, res) => {
  try {
    const { userId } = req.params;
    const { highRiskThreshold, frequencyThreshold } = req.body;
    
    const user = await User.findOne({ userId });
    
    if (!user) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }
    
    if (highRiskThreshold) {
      user.highRiskThreshold = highRiskThreshold;
    }
    
    if (frequencyThreshold) {
      user.frequencyThreshold = {
        ...user.frequencyThreshold,
        ...frequencyThreshold
      };
    }
    
    await user.save();
    
    return res.status(200).json({
      status: "success",
      message: "Risk profile updated",
      user
    });
  } catch (error) {
    console.error("Error updating risk profile:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to update risk profile"
    });
  }
};

// routes/fraudRoutes.js
const express = require("express");
const router = express.Router();
const fraudController = require("../controllers/fraudController");

// Analyze a new transaction for fraud
router.post("/transactions/analyze", fraudController.analyzeTransaction);

// Get transaction history for a user
router.get("/transactions/:userId", fraudController.getTransactionHistory);

// Update risk profile for a user
router.patch("/users/:userId/risk-profile", fraudController.updateRiskProfile);

module.exports = router;

// .env (example)
// MONGO_URI=mongodb://localhost:27017/fraud_detection
