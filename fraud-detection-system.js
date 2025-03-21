
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


const Transaction = require("../models/Transaction");
const User = require("../models/User");

class FraudDetectionService {
  
  async analyzeTransaction(transaction) {
    const riskFactors = [];
    let riskScore = 0;
    

    let user = await User.findOne({ userId: transaction.userId });
    

    if (!user) {
      user = new User({ userId: transaction.userId });
      await user.save();
    }
    
    
    if (transaction.amount > user.highRiskThreshold) {
      riskFactors.push("high_amount");
      riskScore += 30;
    }
    
    
    if (user.usualCountries.length > 0 && !user.usualCountries.includes(transaction.country)) {
      riskFactors.push("unusual_country");
      riskScore += 25;
    }
    

    const transactionHour = new Date(transaction.timestamp).getHours();
    if (user.usualTransactionTimes.length > 0 && !user.usualTransactionTimes.includes(transactionHour)) {
      riskFactors.push("unusual_time");
      riskScore += 15;
    }
    
    
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
    
    const newAverage = (user.averageTransactionAmount * user.transactionCount + transaction.amount) / (user.transactionCount + 1);
    user.averageTransactionAmount = newAverage;
    
    
    user.transactionCount += 1;
    

    const transactionHour = new Date(transaction.timestamp).getHours();
    if (!user.usualTransactionTimes.includes(transactionHour)) {
      user.usualTransactionTimes.push(transactionHour);
    }
    

    if (!user.usualCountries.includes(transaction.country)) {
      user.usualCountries.push(transaction.country);
    }
    
    
    await user.save();
  }
}

module.exports = new FraudDetectionService();


const Transaction = require("../models/Transaction");
const fraudDetectionService = require("../services/fraudDetectionService");

exports.analyzeTransaction = async (req, res) => {
  try {
    const { userId, amount, receiverAddress, country } = req.body;
    
    
    if (!userId || !amount || !receiverAddress || !country) {
      return res.status(400).json({ 
        status: "error", 
        message: "Missing required fields" 
      });
    }
    
    
    const transaction = new Transaction({
      userId,
      amount,
      receiverAddress,
      country,
      timestamp: new Date()
    });
    
    
    const riskAnalysis = await fraudDetectionService.analyzeTransaction(transaction);
    

    transaction.risk = {
      score: riskAnalysis.riskScore,
      factors: riskAnalysis.riskFactors
    };
    transaction.status = riskAnalysis.status;
    

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


const express = require("express");
const router = express.Router();
const fraudController = require("../controllers/fraudController");


router.post("/transactions/analyze", fraudController.analyzeTransaction);

router.get("/transactions/:userId", fraudController.getTransactionHistory);


router.patch("/users/:userId/risk-profile", fraudController.updateRiskProfile);

module.exports = router;


