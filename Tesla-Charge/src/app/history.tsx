import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '@/config/firebase';

export default function HistoryScreen() {
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    // Listen to latest 20 transactions from Firestore
    const q = query(
      collection(db, 'transactions'),
      orderBy('startTime', 'desc'),
      limit(20)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: any[] = [];
        snapshot.forEach((doc) => {
          list.push({ id: doc.id, ...doc.data() });
        });
        setTransactions(list);
        setLoading(false);
        setRefreshing(false);
      },
      (err) => {
        console.error('Error fetching transactions:', err);
        setLoading(false);
        setRefreshing(false);
      }
    );

    return () => unsubscribe();
  }, []);

  const totalEnergy = transactions.reduce((acc, curr) => acc + (curr.energyDeliveredKwh || 0), 0);
  const totalCost = transactions.reduce((acc, curr) => acc + (curr.cost || 0), 0);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#0284C7" />
        <Text style={styles.loadingText}>Loading charging history...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => setRefreshing(true)}
          tintColor="#0284C7"
        />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>CHARGING HISTORY</Text>
        <Text style={styles.headerSubtitle}>Past charging sessions & receipt records</Text>
      </View>

      {/* Summary Cards */}
      <View style={styles.summaryGrid}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>TOTAL ENERGY</Text>
          <Text style={styles.summaryValue}>{totalEnergy.toFixed(1)} kWh</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>TOTAL SPENT</Text>
          <Text style={styles.summaryValue}>${totalCost.toFixed(2)}</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>SESSIONS</Text>
          <Text style={styles.summaryValue}>{transactions.length}</Text>
        </View>
      </View>

      {/* Transactions List */}
      {transactions.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyIcon}>🔋</Text>
          <Text style={styles.emptyText}>No charging sessions recorded yet.</Text>
          <Text style={styles.emptySubtext}>Plug in a car to view live sessions and receipts!</Text>
        </View>
      ) : (
        <View style={styles.listContainer}>
          {transactions.map((tx) => {
            const isPaid = tx.paymentStatus === 'Paid';
            const dateStr = tx.startTime ? new Date(tx.startTime).toLocaleDateString() : 'Recent';
            const timeStr = tx.startTime ? new Date(tx.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

            return (
              <View key={tx.id} style={styles.txCard}>
                <View style={styles.txHeader}>
                  <View>
                    <Text style={styles.txDate}>{dateStr} • {timeStr}</Text>
                    <Text style={styles.txId}>Session #{tx.transactionId || tx.id}</Text>
                  </View>
                  <View style={[styles.badge, isPaid ? styles.paidBadge : styles.pendingBadge]}>
                    <Text style={[styles.badgeText, isPaid ? styles.paidText : styles.pendingText]}>
                      {isPaid ? 'PAID' : 'PENDING'}
                    </Text>
                  </View>
                </View>

                <View style={styles.txDivider} />

                <View style={styles.txDetailsRow}>
                  <View>
                    <Text style={styles.detailLabel}>ENERGY DELIVERED</Text>
                    <Text style={styles.detailValueBold}>
                      {tx.energyDeliveredKwh !== undefined ? `${tx.energyDeliveredKwh} kWh` : 'In Progress'}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.detailLabel}>TOTAL AMOUNT</Text>
                    <Text style={styles.costValue}>${(tx.cost || 0).toFixed(2)}</Text>
                  </View>
                </View>

                {tx.reason && (
                  <Text style={styles.txReason}>
                    Ended: {tx.reason}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      )}

      <View style={{ height: 100 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    padding: 18,
    paddingTop: Platform.OS === 'ios' ? 60 : 36,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 14,
    color: '#64748B',
    fontSize: 14,
    fontWeight: '600',
  },
  header: {
    marginBottom: 18,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 1,
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
    fontWeight: '500',
  },
  summaryGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 6,
    elevation: 2,
  },
  summaryLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  summaryValue: {
    fontSize: 16,
    fontWeight: '900',
    color: '#0284C7',
  },
  listContainer: {
    gap: 12,
  },
  txCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  txHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  txDate: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },
  txId: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 2,
    fontWeight: '500',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  paidBadge: {
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
  },
  pendingBadge: {
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  paidText: {
    color: '#065F46',
  },
  pendingText: {
    color: '#92400E',
  },
  txDivider: {
    height: 1,
    backgroundColor: '#F1F5F9',
    marginVertical: 12,
  },
  txDetailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  detailLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  detailValueBold: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  costValue: {
    fontSize: 16,
    fontWeight: '900',
    color: '#059669',
  },
  txReason: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 8,
    fontStyle: 'italic',
  },
  emptyCard: {
    padding: 36,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    marginTop: 16,
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 10,
  },
  emptyText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0F172A',
  },
  emptySubtext: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 4,
    textAlign: 'center',
  },
});
