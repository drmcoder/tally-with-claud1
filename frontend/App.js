// App.js - Complete Frontend Dashboard
import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import './App.css';

const API_URL = 'http://localhost:3001';
const socket = io(API_URL);

function App() {
  const [bills, setBills] = useState([]);
  const [filter, setFilter] = useState('all');
  const [language, setLanguage] = useState('en');
  const [activeTab, setActiveTab] = useState('bills');
  const [daybook, setDaybook] = useState([]);
  
  // Translations
  const t = {
    en: {
      dashboard: 'Dashboard',
      bills: 'Bills',
      payment: 'Payment',
      dispatch: 'Dispatch',
      pending: 'Pending',
      paid: 'Paid',
      markPaid: 'Mark as Paid',
      totalPending: 'Total Pending',
      totalPaid: 'Total Paid',
      party: 'Party',
      amount: 'Amount',
      status: 'Status',
      date: 'Date',
      daybook: 'Daybook',
      debit: 'Debit',
      credit: 'Credit',
      balance: 'Balance',
      syncNow: 'Sync Now'
    },
    ne: {
      dashboard: 'ड्यासबोर्ड',
      bills: 'बिलहरू',
      payment: 'भुक्तानी',
      dispatch: 'पठाउने',
      pending: 'बाँकी',
      paid: 'भुक्तान भयो',
      markPaid: 'भुक्तानी भयो भनेर चिन्ह लगाउनुहोस्',
      totalPending: 'कुल बाँकी',
      totalPaid: 'कुल भुक्तानी',
      party: 'पार्टी',
      amount: 'रकम',
      status: 'स्थिति',
      date: 'मिति',
      daybook: 'दैनिक खाता',
      debit: 'डेबिट',
      credit: 'क्रेडिट',
      balance: 'बाँकी',
      syncNow: 'सिंक गर्नुहोस्'
    }
  };

  useEffect(() => {
    fetchBills();
    fetchDaybook();
    
    // Socket listeners
    socket.on('bills_updated', (data) => {
      fetchBills();
      showNotification('New bills synced from Tally!');
    });
    
    socket.on('payment_updated', (data) => {
      fetchBills();
      showNotification(`Payment updated for ${data.voucherNumber}`);
    });
    
    return () => {
      socket.off('bills_updated');
      socket.off('payment_updated');
    };
  }, []);

  const fetchBills = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/bills`);
      setBills(response.data);
    } catch (error) {
      console.error('Error fetching bills:', error);
    }
  };

  const fetchDaybook = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/daybook`);
      setDaybook(response.data);
    } catch (error) {
      console.error('Error fetching daybook:', error);
    }
  };

  const updatePayment = async (voucherNumber, amount) => {
    if (!window.confirm(`Mark ${voucherNumber} as paid?`)) return;
    
    try {
      await axios.post(`${API_URL}/api/bills/${voucherNumber}/payment`, {
        status: 'paid',
        amount: amount,
        cashierId: 'CASHIER001'
      });
      
      showNotification(`Payment recorded for ${voucherNumber}`);
      fetchBills();
    } catch (error) {
      alert('Error updating payment: ' + error.message);
    }
  };

  const updateDispatch = async (voucherNumber, status) => {
    try {
      await axios.post(`${API_URL}/api/bills/${voucherNumber}/dispatch`, {
        status: status,
        gatePassNo: `GP${Date.now()}`
      });
      
      fetchBills();
    } catch (error) {
      alert('Error updating dispatch: ' + error.message);
    }
  };

  const syncNow = async () => {
    try {
      const response = await axios.post(`${API_URL}/api/sync`);
      showNotification(`Synced ${response.data.billssynced} bills`);
      fetchBills();
    } catch (error) {
      alert('Sync error: ' + error.message);
    }
  };

  const showNotification = (message) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Tally Dashboard', {
        body: message,
        icon: '/logo192.png'
      });
    }
  };

  // Request notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const filteredBills = bills.filter(bill => {
    if (filter === 'all') return true;
    if (filter === 'pending') return bill.payment_status === 'pending';
    if (filter === 'paid') return bill.payment_status === 'paid';
    return true;
  });

  const stats = {
    total: bills.length,
    pending: bills.filter(b => b.payment_status === 'pending').length,
    paid: bills.filter(b => b.payment_status === 'paid').length,
    pendingAmount: bills
      .filter(b => b.payment_status === 'pending')
      .reduce((sum, b) => sum + parseFloat(b.amount || 0), 0),
    paidAmount: bills
      .filter(b => b.payment_status === 'paid')
      .reduce((sum, b) => sum + parseFloat(b.payment_amount || 0), 0)
  };

  return (
    <div className="App">
      <header className="header">
        <h1>🏪 Ome 82 to More - {t[language].dashboard}</h1>
        <div className="header-controls">
          <button onClick={syncNow} className="sync-btn">
            🔄 {t[language].syncNow}
          </button>
          <button 
            onClick={() => setLanguage(language === 'en' ? 'ne' : 'en')}
            className="lang-btn"
          >
            {language === 'en' ? 'नेपाली' : 'English'}
          </button>
        </div>
      </header>

      <div className="stats">
        <div className="stat-card">
          <h3>Total Bills</h3>
          <p>{stats.total}</p>
        </div>
        <div className="stat-card pending">
          <h3>{t[language].totalPending}</h3>
          <p>{stats.pending}</p>
          <small>Rs. {stats.pendingAmount.toFixed(2)}</small>
        </div>
        <div className="stat-card paid">
          <h3>{t[language].totalPaid}</h3>
          <p>{stats.paid}</p>
          <small>Rs. {stats.paidAmount.toFixed(2)}</small>
        </div>
      </div>

      <div className="tabs">
        <button 
          className={activeTab === 'bills' ? 'active' : ''}
          onClick={() => setActiveTab('bills')}
        >
          {t[language].bills}
        </button>
        <button 
          className={activeTab === 'daybook' ? 'active' : ''}
          onClick={() => setActiveTab('daybook')}
        >
          {t[language].daybook}
        </button>
      </div>

      <div className="filter-bar">
        <button 
          className={filter === 'all' ? 'active' : ''}
          onClick={() => setFilter('all')}
        >
          All ({stats.total})
        </button>
        <button 
          className={filter === 'pending' ? 'active' : ''}
          onClick={() => setFilter('pending')}
        >
          {t[language].pending} ({stats.pending})
        </button>
        <button 
          className={filter === 'paid' ? 'active' : ''}
          onClick={() => setFilter('paid')}
        >
          {t[language].paid} ({stats.paid})
        </button>
      </div>

      {activeTab === 'bills' && (
        <div className="bills-grid">
          {filteredBills.map(bill => (
            <div 
              key={bill.voucher_number} 
              className={`bill-card ${bill.payment_status}`}
            >
              <div className="bill-header">
                <h3>{bill.voucher_number}</h3>
                <span className={`status ${bill.payment_status}`}>
                  {t[language][bill.payment_status] || bill.payment_status}
                </span>
              </div>
              <div className="bill-body">
                <p><strong>{t[language].party}:</strong> {bill.party_name}</p>
                <p><strong>{t[language].amount}:</strong> Rs. {bill.amount}</p>
                <p><strong>{t[language].date}:</strong> {bill.voucher_date}</p>
                <p><strong>{t[language].dispatch}:</strong> {bill.dispatch_status}</p>
              </div>
              <div className="bill-actions">
                {bill.payment_status === 'pending' && (
                  <button 
                    onClick={() => updatePayment(bill.voucher_number, bill.amount)}
                    className="btn-pay"
                  >
                    💰 {t[language].markPaid}
                  </button>
                )}
                <select 
                  value={bill.dispatch_status}
                  onChange={(e) => updateDispatch(bill.voucher_number, e.target.value)}
                >
                  <option value="pending">Pending</option>
                  <option value="ready">Ready</option>
                  <option value="dispatched">Dispatched</option>
                  <option value="customer_taken">Customer Taken</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'daybook' && (
        <div className="daybook-table">
          <table>
            <thead>
              <tr>
                <th>{t[language].party}</th>
                <th>{t[language].debit}</th>
                <th>{t[language].credit}</th>
                <th>{t[language].balance}</th>
              </tr>
            </thead>
            <tbody>
              {daybook.map((entry, index) => (
                <tr key={index}>
                  <td>{entry.party_name}</td>
                  <td>Rs. {parseFloat(entry.debit || 0).toFixed(2)}</td>
                  <td>Rs. {parseFloat(entry.credit || 0).toFixed(2)}</td>
                  <td>Rs. {parseFloat(entry.balance || 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default App;